"""Userscript-facing endpoints: score, log-greeting, config.

These routes serve the Tampermonkey boss-helper.user.js script running
inside the user's real Chrome on zhipin.com. No Playwright dependency.
"""

import logging
from threading import Thread
from typing import Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.database import SessionLocal, get_db
from app.models.candidate import Candidate
from app.models.match_result import (
    COMPLETED_MATCH_STATUSES,
    PENDING_MATCH_STATUSES,
    MatchResult,
)
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
    replace_pending: bool = False  # replace this job's unfinished scan snapshot


class ExtScoreItem(BaseModel):
    expectId: str
    name: str
    score: float
    is_blocked: bool
    details: list[str]
    draft: str
    already_contacted: bool = False  # 同岗位已打过招呼（sent_manual/sent_auto）
    already_skipped: bool = False  # deprecated compatibility field; always false for replacement scans


def _upsert_match_result(
    db: Session,
    candidate,
    job_id: str,
    score_result: dict,
    *,
    commit: bool = True,
):
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
    if commit:
        db.commit()
    else:
        db.flush()


def _clear_unfinished_job_snapshot(db: Session, job_id: str) -> None:
    """Delete one job's unfinished matches and their unsent drafts."""
    stale_match_ids = [
        match_id
        for (match_id,) in db.query(MatchResult.id)
        .filter(MatchResult.job_id == job_id)
        .filter(~MatchResult.status.in_(COMPLETED_MATCH_STATUSES))
        .all()
    ]
    if not stale_match_ids:
        return
    db.query(OutreachRecord).filter(
        OutreachRecord.match_id.in_(stale_match_ids)
    ).delete(synchronize_session=False)
    db.query(MatchResult).filter(
        MatchResult.id.in_(stale_match_ids)
    ).delete(synchronize_session=False)
    db.flush()


def _clear_all_pending_matches(db: Session) -> int:
    """Delete every pending queue row while preserving completed outreach."""
    pending_match_ids = [
        match_id
        for (match_id,) in db.query(MatchResult.id)
        .filter(MatchResult.status.in_(PENDING_MATCH_STATUSES))
        .all()
    ]
    if not pending_match_ids:
        return 0
    db.query(OutreachRecord).filter(
        OutreachRecord.match_id.in_(pending_match_ids)
    ).delete(synchronize_session=False)
    db.query(MatchResult).filter(
        MatchResult.id.in_(pending_match_ids)
    ).delete(synchronize_session=False)
    db.flush()
    return len(pending_match_ids)


def _prune_orphan_candidates(db: Session, keep_candidate_ids: set[int]) -> None:
    """Remove profiles no longer referenced by a match or the current scan."""
    query = db.query(Candidate).filter(
        ~Candidate.id.in_(select(MatchResult.candidate_id))
    )
    if keep_candidate_ids:
        query = query.filter(~Candidate.id.in_(keep_candidate_ids))
    query.delete(synchronize_session=False)


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
    can_replace_pending = bool(
        req.replace_pending
        and req.job_id
        and job_id == req.job_id
        and req.candidates
    )

    # Preserve completed contacts and expose them to the userscript so it never
    # greets the same candidate twice for the same job.
    contacted_ids: set[int] = set()
    if job_id:
        contacted_ids = {
            cid for (cid,) in db.query(MatchResult.candidate_id)
            .filter(
                MatchResult.job_id == job_id,
                MatchResult.status.in_(COMPLETED_MATCH_STATUSES),
            ).all()
        }

    # Finish pure scoring before deleting anything. A scoring error leaves the
    # previous queue snapshot untouched.
    scored_candidates: list[tuple[dict, dict]] = []
    for candidate_dict in req.candidates:
        score_result = (
            score_candidate_by_job(candidate_dict, job)
            if job is not None
            else batch_score_candidate(candidate_dict, profile)
        )
        scored_candidates.append((candidate_dict, score_result))

    results: list[ExtScoreItem] = []
    current_candidate_ids: set[int] = set()
    try:
        # An empty or failed extraction must never erase the last useful list.
        if can_replace_pending:
            _clear_unfinished_job_snapshot(db, job_id)

        for candidate_dict, score_result in scored_candidates:
            saved = upsert_candidate(db, candidate_dict, score_result, commit=False)
            current_candidate_ids.add(saved.id)

            passed = (not score_result["is_blocked"]) and (
                req.threshold is None or score_result["score"] >= req.threshold
            )
            if passed and job_id:
                _upsert_match_result(
                    db,
                    saved,
                    job_id,
                    score_result,
                    commit=False,
                )

            draft = ""
            if job and not score_result["is_blocked"]:
                draft = render_draft(saved, job)

            results.append(ExtScoreItem(
                expectId=candidate_dict.get("expectId", ""),
                name=candidate_dict.get("name", ""),
                score=score_result["score"],
                is_blocked=score_result["is_blocked"],
                details=score_result["details"],
                draft=draft,
                already_contacted=saved.id in contacted_ids,
                # Kept for old userscript response compatibility only.
                already_skipped=False,
            ))

        if can_replace_pending:
            _prune_orphan_candidates(db, current_candidate_ids)
        db.commit()
    except Exception:
        db.rollback()
        raise

    return results


# ── POST /api/ext/log-greeting ───────────────────────────────────────

@router.post("/clear-pending")
def ext_clear_pending(db: Session = Depends(get_db)):
    """Clear all pending queue rows without touching completed contacts."""
    try:
        deleted_matches = _clear_all_pending_matches(db)
        _prune_orphan_candidates(db, set())
        db.commit()
    except Exception:
        db.rollback()
        raise
    return {"deleted_matches": deleted_matches}


class ExtLogGreetingRequest(BaseModel):
    expectId: str
    name: str
    mode: Literal["auto", "manual"]
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
    previous_status = mr.status if mr else None
    newly_completed = previous_status not in COMPLETED_MATCH_STATUSES
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
        "previous_status": previous_status,
        "newly_completed": newly_completed,
    }


# ── POST /api/ext/llm-rerank ─────────────────────────────────────────

class ExtRerankRequest(BaseModel):
    job_id: str | None = None
    limit: int = 60  # safety cap on how many candidates to send to the LLM
    force: bool = False  # explicit opt-in for re-scoring rows that already have an AI score


def _rerank_rows(db: Session, job_id: str, limit: int, include_scored: bool = False):
    """Return the score-ordered shortlist, skipping existing AI scores by default."""
    query = (
        db.query(MatchResult, Candidate)
        .join(Candidate, MatchResult.candidate_id == Candidate.id)
        .filter(MatchResult.job_id == job_id)
        .filter(MatchResult.status.in_(PENDING_MATCH_STATUSES))
    )
    if not include_scored:
        query = query.filter(MatchResult.llm_score.is_(None))
    return (
        query.order_by(MatchResult.score.desc())
        .limit(max(1, min(limit, 200)))
        .all()
    )


def _already_reranked_count(db: Session, job_id: str) -> int:
    """Count active queue rows that already have a durable AI score."""
    return (
        db.query(MatchResult)
        .filter(MatchResult.job_id == job_id)
        .filter(MatchResult.status.in_(PENDING_MATCH_STATUSES))
        .filter(MatchResult.llm_score.is_not(None))
        .count()
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
    skipped_existing = 0 if req.force else _already_reranked_count(db, job.id)
    rows = _rerank_rows(db, job.id, req.limit, include_scored=req.force)
    if not rows:
        message = (
            f"当前岗位已有 {skipped_existing} 人完成 AI 评分，无需重复评分"
            if skipped_existing
            else "队列为空,无可精评的候选人"
        )
        return {
            "configured": True,
            "scored": 0,
            "skipped_existing": skipped_existing,
            "message": message,
        }

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
        "skipped_existing": skipped_existing,
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
    skipped_existing = 0 if req.force else _already_reranked_count(db, job.id)
    rows = _rerank_rows(db, job.id, req.limit, include_scored=req.force)
    if not rows:
        message = (
            f"当前岗位已有 {skipped_existing} 人完成 AI 评分，无需重复评分"
            if skipped_existing
            else "队列为空，无可评分的候选人"
        )
        return {
            "configured": True,
            "completed": True,
            "total": 0,
            "skipped_existing": skipped_existing,
            "message": message,
        }

    task = rerank_jobs.create(job_id=job.id, job_title=job.title, total=len(rows))
    snapshot = [(mr.id, candidate.id, _candidate_brief(candidate)) for mr, candidate in rows]
    Thread(
        target=_run_tracked_rerank,
        args=(task.id, snapshot, llm_scoring.build_job_desc(job)),
        name=f"llm-rerank-{task.id[:8]}",
        daemon=True,
    ).start()
    return {
        "configured": True,
        "task_id": task.id,
        "total": task.total,
        "skipped_existing": skipped_existing,
        "job_title": task.job_title,
    }


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
