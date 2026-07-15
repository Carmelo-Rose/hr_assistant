"""Userscript-facing endpoints: score, log-greeting, config.

These routes serve the Tampermonkey boss-helper.user.js script running
inside the user's real Chrome on zhipin.com. No Playwright dependency.
"""

import logging
from threading import Thread

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.models.database import SessionLocal, get_db
from app.models.candidate import Candidate
from app.models.match_result import MatchResult
from app.models.outreach import OutreachRecord
from app.models.job import Job
from app.routers.jobs import JobCreate, JobOut, JobPatch, create_job, patch_job
from app.services.scoring import batch_score_candidate, score_candidate_by_job, load_profile
from app.services.ingest import upsert_candidate
from app.services.templating import render_draft
from app.services import llm_scoring
from app.services.rerank_jobs import rerank_jobs

logger = logging.getLogger(__name__)
router = APIRouter()


# ── POST /api/ext/score ──────────────────────────────────────────────

class ExtScoreRequest(BaseModel):
    candidates: list[dict]
    job_id: str | None = None
    threshold: float | None = None  # only queue candidates scoring >= this


class ExtScoreItem(BaseModel):
    expectId: str
    name: str
    score: float
    is_blocked: bool
    details: list[str]
    draft: str
    already_contacted: bool = False  # 同岗位已打过招呼（sent_manual/sent_auto）
    already_skipped: bool = False  # 同岗位被手动跳过（status=skipped），不会自动回队


def _upsert_match_result(db: Session, candidate, job_id: str, score_result: dict):
    """Create or refresh a MatchResult so the candidate appears in the queue.

    Idempotent: re-scanning updates the score/reason but never clobbers a
    candidate already moved past 'new'/'queued' (e.g. already contacted).
    """
    reason = "；".join(score_result.get("details", []))
    mr = db.query(MatchResult).filter(
        MatchResult.candidate_id == candidate.id,
        MatchResult.job_id == job_id,
    ).first()
    if mr:
        mr.score = score_result["score"]
        mr.age_pass = score_result.get("age_pass", 1)
        mr.experience_match = score_result.get("experience_match", 1)
        mr.capability_match = score_result.get("capability_match", 1)
        if mr.status in ("new", "queued"):
            mr.match_reason = reason
    else:
        mr = MatchResult(
            candidate_id=candidate.id,
            job_id=job_id,
            score=score_result["score"],
            match_reason=reason,
            missing_info="",
            status="new",
            age_pass=score_result.get("age_pass", 1),
            experience_match=score_result.get("experience_match", 1),
            capability_match=score_result.get("capability_match", 1),
        )
        db.add(mr)
    db.commit()


def _upsert_outreach(db: Session, mr, candidate_id: int, job_id: str,
                     *, draft_text: str | None = None, status: str | None = None):
    """Find-or-create the OutreachRecord for a match, setting only given fields."""
    record = db.query(OutreachRecord).filter(OutreachRecord.match_id == mr.id).first()
    if record is None:
        record = OutreachRecord(match_id=mr.id, candidate_id=candidate_id, job_id=job_id)
        db.add(record)
    if draft_text is not None:
        record.draft_text = draft_text
    if status is not None:
        record.status = status
    return record


@router.post("/score", response_model=list[ExtScoreItem])
def ext_score(req: ExtScoreRequest, db: Session = Depends(get_db)):
    """Score candidates from the userscript, upsert to DB, generate drafts.

    Each candidate dict matches EXTRACT_CARDS_JS output shape.
    Returns scored & enriched list for the script panel to display.
    """
    profile = load_profile()
    job = db.query(Job).filter(Job.id == req.job_id).first() if req.job_id else None
    # Fall back to the first job so queued candidates have a valid FK target.
    if job is None:
        job = db.query(Job).first()
    job_id = job.id if job else None

    # Pre-fetch candidates already greeted for this job so the panel can grey
    # them out and auto-mode can skip them (avoid re-greeting the same person).
    contacted_ids: set[int] = set()
    skipped_ids: set[int] = set()
    if job_id:
        contacted_ids = {
            cid for (cid,) in db.query(MatchResult.candidate_id)
            .filter(
                MatchResult.job_id == job_id,
                MatchResult.status.in_(["sent_manual", "sent_auto"]),
            ).all()
        }
        # 被手动跳过的人：重扫不会回队（_upsert_match_result 不复活 skipped），
        # 面板据此把卡片标灰，避免和"新入队"数对不上。
        skipped_ids = {
            cid for (cid,) in db.query(MatchResult.candidate_id)
            .filter(
                MatchResult.job_id == job_id,
                MatchResult.status == "skipped",
            ).all()
        }

    results: list[ExtScoreItem] = []
    for c in req.candidates:
        # Prefer scoring against the selected workbench job; fall back to the
        # YAML profile only when no job exists at all.
        if job is not None:
            score_result = score_candidate_by_job(c, job)
        else:
            score_result = batch_score_candidate(c, profile)
        saved = upsert_candidate(db, c, score_result)

        # Auto-enqueue: candidates that pass the filter (not blocked) and meet
        # the threshold get a MatchResult so they show up in the Dashboard queue.
        passed = (not score_result["is_blocked"]) and (
            req.threshold is None or score_result["score"] >= req.threshold
        )
        if passed and job_id:
            _upsert_match_result(db, saved, job_id, score_result)

        # Generate greeting draft
        draft = ""
        if job and not score_result["is_blocked"]:
            draft = render_draft(saved, job)

        results.append(ExtScoreItem(
            expectId=c.get("expectId", ""),
            name=c.get("name", ""),
            score=score_result["score"],
            is_blocked=score_result["is_blocked"],
            details=score_result["details"],
            draft=draft,
            already_contacted=saved.id in contacted_ids,
            already_skipped=saved.id in skipped_ids,
        ))

    return results


# ── POST /api/ext/log-greeting ───────────────────────────────────────

class ExtLogGreetingRequest(BaseModel):
    expectId: str
    name: str
    mode: str  # auto | manual
    job_id: str | None = None


@router.post("/log-greeting")
def ext_log_greeting(req: ExtLogGreetingRequest, db: Session = Depends(get_db)):
    """Log that a greeting was sent, so the Dashboard shows it.

    Creates MatchResult + OutreachRecord with status sent_auto / sent_manual.
    """
    candidate = db.query(Candidate).filter(
        Candidate.expect_id == req.expectId
    ).first()
    if not candidate:
        # Upsert a minimal stub so the record has a FK target
        stub_dict = {"expectId": req.expectId, "name": req.name}
        score_result = batch_score_candidate(stub_dict, load_profile())
        candidate = upsert_candidate(db, stub_dict, score_result)

    # Use default job if not specified
    job_id = req.job_id
    if not job_id:
        jobs = db.query(Job).all()
        job_id = jobs[0].id if jobs else "default"

    # Upsert MatchResult
    mr = db.query(MatchResult).filter(
        MatchResult.candidate_id == candidate.id,
        MatchResult.job_id == job_id,
    ).first()
    if mr:
        mr.status = f"sent_{req.mode}"
        mr.score = candidate.score or 0
    else:
        mr = MatchResult(
            candidate_id=candidate.id,
            job_id=job_id,
            score=candidate.score or 0,
            match_reason="",
            missing_info="",
            status=f"sent_{req.mode}",
        )
        db.add(mr)
    db.commit()
    db.refresh(mr)

    # Upsert OutreachRecord
    _upsert_outreach(db, mr, candidate.id, job_id, status=f"sent_{req.mode}")
    db.commit()

    return {
        "match_id": mr.id,
        "candidate_id": candidate.id,
        "status": f"sent_{req.mode}",
    }


# ── POST /api/ext/llm-rerank ─────────────────────────────────────────

class ExtRerankRequest(BaseModel):
    job_id: str | None = None
    limit: int = 60  # safety cap on how many candidates to send to the LLM


def _rerank_rows(db: Session, job_id: str, limit: int):
    """Return the same score-ordered shortlist for sync and tracked scoring."""
    return (
        db.query(MatchResult, Candidate)
        .join(Candidate, MatchResult.candidate_id == Candidate.id)
        .filter(MatchResult.job_id == job_id)
        .filter(~MatchResult.status.in_(["sent_manual", "skipped"]))
        .order_by(MatchResult.score.desc())
        .limit(max(1, min(limit, 200)))
        .all()
    )


def _candidate_brief(c: Candidate) -> dict:
    """Compact candidate summary for the LLM (id keyed to DB candidate.id)."""
    return {
        "id": c.id,
        "简介": (c.experience_summary or c.raw_snapshot or "")[:400],
        "年龄": c.age,
        "学历": c.education or "",
        "经验": c.work_years or "",
        "期望薪资": c.salary_range or "",
        "公司": c.current_company or "",
        "职位": c.current_position or "",
        "技能": c.skills or "",
    }


@router.post("/llm-rerank")
def ext_llm_rerank(req: ExtRerankRequest, db: Session = Depends(get_db)):
    """LLM 精评:对队列里待处理(new/queued)的入围候选人用国产大模型重排打分。

    只评入围名单(规则已粗筛过),成本可控。写入 MatchResult.llm_score / llm_reason。
    """
    if not llm_scoring.is_configured():
        return {
            "configured": False,
            "error": f"LLM 未配置 —— {llm_scoring.config_hint()}。请在 backend/.env 设置后重启。",
            "scored": 0,
        }

    job = db.query(Job).filter(Job.id == req.job_id).first() if req.job_id else None
    if job is None:
        job = db.query(Job).first()
    if job is None:
        return {"configured": True, "error": "无岗位配置", "scored": 0}

    # 取该岗位下待处理(未发送/未跳过)的候选人,按规则分高→低,限量送评
    rows = _rerank_rows(db, job.id, req.limit)
    if not rows:
        return {"configured": True, "scored": 0, "message": "队列为空,无可精评的候选人"}

    briefs = [_candidate_brief(c) for _, c in rows]
    job_desc = llm_scoring.build_job_desc(job)

    try:
        scores = llm_scoring.score_candidates(briefs, job_desc)
    except Exception as e:
        logger.exception("LLM 精评失败")
        return {"configured": True, "error": f"LLM 调用失败: {e}", "scored": 0}

    updated = 0
    for mr, c in rows:
        s = scores.get(c.id)
        if not s:
            continue
        mr.llm_score = s["score"]
        mr.llm_reason = s["reason"]
        updated += 1
    db.commit()

    return {
        "configured": True,
        "scored": updated,
        "total": len(rows),
        "job_title": job.title,
    }


def _run_tracked_rerank(task_id: str, rows: list[tuple[int, int, dict]], job_desc: str) -> None:
    """Score one LLM batch at a time and expose only completed, durable work."""
    rerank_jobs.update(task_id, status="running", message="正在准备候选人信息")
    # The userscript progress UI is deliberately one candidate at a time:
    # each visible increment represents a completed, committed LLM result.
    # The legacy synchronous endpoint keeps its configurable larger batches.
    batch_size = 1
    processed = 0
    scored = 0
    try:
        for start in range(0, len(rows), batch_size):
            batch = rows[start : start + batch_size]
            rerank_jobs.update(
                task_id,
                message=f"正在评分第 {start // batch_size + 1} 批（{len(batch)} 人）",
            )
            scores = llm_scoring.score_batch([brief for _, _, brief in batch], job_desc)

            # The scoring response is committed batch-by-batch.  A later error
            # never hides progress the user has already seen as completed.
            db = SessionLocal()
            try:
                for match_id, candidate_id, _ in batch:
                    result = scores.get(candidate_id)
                    if not result:
                        continue
                    db.query(MatchResult).filter(MatchResult.id == match_id).update({
                        "llm_score": result["score"],
                        "llm_reason": result["reason"],
                    })
                    scored += 1
                db.commit()
            finally:
                db.close()

            processed += len(batch)
            rerank_jobs.update(
                task_id,
                processed=processed,
                scored=scored,
                message=f"已完成 {processed}/{len(rows)} 位候选人评分",
            )
    except Exception as exc:
        logger.exception("AI 评分任务失败")
        rerank_jobs.update(
            task_id,
            status="failed",
            processed=processed,
            scored=scored,
            error=f"LLM 调用失败: {exc}",
            message="AI评分失败",
        )
        return

    rerank_jobs.update(
        task_id,
        status="succeeded",
        processed=processed,
        scored=scored,
        message=f"AI评分完成：已写入 {scored}/{len(rows)} 人",
    )


@router.post("/llm-rerank-jobs", status_code=202)
def start_llm_rerank_job(req: ExtRerankRequest, db: Session = Depends(get_db)):
    """Start a tracked scoring task for the userscript queue panel."""
    if not llm_scoring.is_configured():
        return {
            "configured": False,
            "error": f"LLM 未配置 —— {llm_scoring.config_hint()}。请在 backend/.env 设置后重启。",
        }
    if not req.job_id:
        return {"configured": True, "error": "请选择具体岗位后进行 AI评分"}

    job = db.query(Job).filter(Job.id == req.job_id).first()
    if job is None:
        return {"configured": True, "error": "岗位不存在"}
    rows = _rerank_rows(db, job.id, req.limit)
    if not rows:
        return {"configured": True, "error": "队列为空，无可评分的候选人"}

    task = rerank_jobs.create(job_id=job.id, job_title=job.title, total=len(rows))
    snapshot = [(mr.id, candidate.id, _candidate_brief(candidate)) for mr, candidate in rows]
    Thread(
        target=_run_tracked_rerank,
        args=(task.id, snapshot, llm_scoring.build_job_desc(job)),
        name=f"llm-rerank-{task.id[:8]}",
        daemon=True,
    ).start()
    return {"configured": True, "task_id": task.id, "total": task.total, "job_title": task.job_title}


@router.get("/llm-rerank-jobs/{task_id}")
def get_llm_rerank_job(task_id: str):
    task = rerank_jobs.get(task_id)
    if task is None:
        return {"error": "评分任务不存在或服务已重启"}
    return task


@router.post("/llm-rerank-jobs/{task_id}/status")
def get_llm_rerank_job_status(task_id: str):
    """POST polling fallback for restrictive userscript/network environments."""
    return get_llm_rerank_job(task_id)


# ── POST /api/ext/llm-draft ──────────────────────────────────────────

class ExtDraftRequest(BaseModel):
    expectId: str
    job_id: str | None = None


@router.post("/llm-draft")
def ext_llm_draft(req: ExtDraftRequest, db: Session = Depends(get_db)):
    """生成单个候选人的个性化打招呼语（国产 LLM）。

    打招呼前按需调用，只对要联系的人花 token。未配置或失败时回退静态模板，
    绝不阻断打招呼。结果缓存到 OutreachRecord.draft_text，避免重复花钱。
    """
    candidate = db.query(Candidate).filter(Candidate.expect_id == req.expectId).first()
    job = db.query(Job).filter(Job.id == req.job_id).first() if req.job_id else None
    if job is None:
        job = db.query(Job).first()
    if not candidate or not job:
        return {"draft": "", "source": "none", "error": "候选人或岗位不存在"}

    draft, source = "", "template"
    if llm_scoring.is_configured():
        try:
            brief = _candidate_brief(candidate)
            job_desc = llm_scoring.build_job_desc(job)
            draft = llm_scoring.draft_greeting(brief, job_desc, job.template or "")
            if draft:
                source = "llm"
        except Exception:
            logger.exception("LLM 话术生成失败，回退模板")
            draft = ""
    if not draft:
        draft = render_draft(candidate, job)
        source = "template"

    # 缓存到 OutreachRecord（若该候选人已入队）
    mr = db.query(MatchResult).filter(
        MatchResult.candidate_id == candidate.id,
        MatchResult.job_id == job.id,
    ).first()
    if mr:
        _upsert_outreach(db, mr, candidate.id, job.id, draft_text=draft)
        db.commit()

    return {"draft": draft, "source": source}


# ── Cross-tab "jump to BOSS" relay ─────────────────────────────────────
# Dashboard (localhost:5173/8000) and the BOSS tab (zhipin.com) are separate
# origins/tabs with no direct channel between them. The Dashboard posts a
# "please open this candidate" request here; the userscript polls this from
# inside the BOSS tab and, if that candidate's card is still on screen,
# clicks it open and focuses the tab. Best-effort only: requires the BOSS tab
# (with that candidate's card still rendered) to still be open somewhere.
# Single in-memory slot is enough — this is a local single-user app.

_pending_open: dict | None = None


class OpenCandidateRequest(BaseModel):
    boss_id: str
    name: str = ""


@router.post("/open-candidate")
def ext_open_candidate(req: OpenCandidateRequest):
    """Dashboard calls this on row click to request a cross-tab jump."""
    global _pending_open
    if not req.boss_id:
        return {"ok": False, "error": "缺少 boss_id"}
    _pending_open = {"boss_id": req.boss_id, "name": req.name}
    return {"ok": True}


@router.get("/pending-open")
def ext_pending_open():
    """Userscript polls this; the request is consumed on read (fires once)."""
    global _pending_open
    pending = _pending_open
    _pending_open = None
    return pending or {"boss_id": ""}


# ── GET /api/ext/jobs ────────────────────────────────────────────────

@router.get("/jobs", response_model=list[JobOut])
def ext_jobs(db: Session = Depends(get_db)):
    """List workbench jobs for the userscript's job picker."""
    return db.query(Job).all()


@router.post("/jobs", response_model=JobOut)
def ext_create_job(payload: JobCreate, db: Session = Depends(get_db)):
    """Create a workbench job from the userscript panel."""
    return create_job(payload, db)


@router.patch("/jobs/{job_id}", response_model=JobOut)
def ext_patch_job(job_id: str, patch: JobPatch, db: Session = Depends(get_db)):
    """Update a workbench job from the userscript panel."""
    return patch_job(job_id, patch, db)


# ── GET /api/ext/config ──────────────────────────────────────────────

@router.get("/config")
def ext_config():
    """Return YAML config for the userscript panel defaults.

    Includes keywords, filters, greeting template, and automation params.
    """
    profile = load_profile()
    return {
        "keywords": profile.get("keywords", []),
        "job": profile.get("job", {}),
        "filter": profile.get("filter", {}),
        "scoring": profile.get("scoring", {}),
        "greeting": profile.get("greeting", {}),
        "automation": profile.get("automation", {}),
        # Lets the userscript skip the /llm-draft round-trip when no LLM is set up
        # (it would just return the template the panel already has from /score).
        "llm_enabled": llm_scoring.is_configured(),
    }
