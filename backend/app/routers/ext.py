"""Userscript-facing endpoints: score, log-greeting, config.

These routes serve the Tampermonkey boss-helper.user.js script running
inside the user's real Chrome on zhipin.com. No Playwright dependency.
"""

import logging

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.models.database import get_db
from app.models.candidate import Candidate
from app.models.match_result import MatchResult
from app.models.outreach import OutreachRecord
from app.models.job import Job
from app.services.scoring import batch_score_candidate, score_candidate_by_job, load_profile
from app.services.ingest import upsert_candidate
from app.services.templating import render_draft
from app.services import llm_scoring

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


def _candidate_brief(c: Candidate) -> dict:
    """Compact candidate summary for the LLM (id keyed to DB candidate.id)."""
    return {
        "id": c.id,
        "简介": (c.experience_summary or c.raw_snapshot or "")[:400],
        "年龄": c.age,
        "学历": c.education or "",
        "经验": c.work_years or "",
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
    q = (
        db.query(MatchResult, Candidate)
        .join(Candidate, MatchResult.candidate_id == Candidate.id)
        .filter(MatchResult.job_id == job.id)
        .filter(~MatchResult.status.in_(["sent_manual", "skipped"]))
        .order_by(MatchResult.score.desc())
        .limit(max(1, min(req.limit, 200)))
    )
    rows = q.all()
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


# ── GET /api/ext/jobs ────────────────────────────────────────────────

@router.get("/jobs")
def ext_jobs(db: Session = Depends(get_db)):
    """List workbench jobs for the userscript's job picker."""
    jobs = db.query(Job).all()
    return [{"id": j.id, "title": j.title} for j in jobs]


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
