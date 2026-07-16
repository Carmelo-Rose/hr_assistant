"""Today's outreach queue."""

from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session
from sqlalchemy import desc, func

from app.models.database import get_db
from app.models.candidate import Candidate
from app.models.match_result import MatchResult
from app.models.outreach import OutreachRecord
from app.models.job import Job

router = APIRouter()


class QueueItem(BaseModel):
    match_id: int
    candidate_id: int
    job_id: str
    job_title: str
    name: str
    score: float
    match_reason: str
    missing_info: str
    age_pass: int
    experience_match: int
    capability_match: int
    active_status: str
    status: str
    outreach_id: int | None = None
    llm_score: float | None = None
    llm_reason: str = ""
    # 候选人原始信息(用于列表内联展示,对齐 BOSS"推荐牛人"卡片信息量)
    boss_id: str = ""  # 候选人在 BOSS 页面上的卡片标识(data-geek),用于"跳转到 BOSS"功能
    age: int | None = None
    education: str = ""
    work_years: str = ""
    salary_range: str = ""
    job_status: str = ""
    expected_city: str = ""
    skills: str = ""
    # Persisted candidate archive fields. The userscript uses these when the
    # live BOSS card is no longer rendered after a refresh or page change.
    company: str = ""
    title: str = ""
    school: str = ""
    major: str = ""
    experience_summary: str = ""
    raw_snapshot: str = ""
    source_keyword: str = ""
    share_url: str = ""
    created_at: datetime | None = None
    updated_at: datetime | None = None


@router.get("/queue/today")
def get_today_queue(
    job_id: Optional[str] = Query(None),
    status_filter: Optional[str] = Query(None),
    limit: Optional[int] = Query(None, ge=1, le=500),
    db: Session = Depends(get_db),
):
    """
    Build today's queue:
    - For each MatchResult that is NOT sent_manual/skipped, or if already queued
    - Order by: score desc, active_status bonus, completeness
    - Dedup by (candidate_id, job_id) so one candidate can appear once per job
    """
    query = (
        db.query(MatchResult)
        .join(Candidate, MatchResult.candidate_id == Candidate.id)
        .join(Job, MatchResult.job_id == Job.id)
        .outerjoin(OutreachRecord, MatchResult.id == OutreachRecord.match_id)
    )

    # Filters
    if job_id:
        query = query.filter(MatchResult.job_id == job_id)
    if status_filter:
        query = query.filter(MatchResult.status == status_filter)
    else:
        # Default: exclude finished ones
        query = query.filter(~MatchResult.status.in_(["sent_manual", "skipped"]))

    # Status priority for ordering
    from sqlalchemy import case
    status_order = case(
        (MatchResult.status == "new", 0),
        (MatchResult.status == "queued", 1),
        else_=2,
    )

    results = (
        query.add_columns(
            Candidate.name,
            Candidate.active_status,
            Candidate.boss_id,
            Candidate.age,
            Candidate.education,
            Candidate.work_years,
            Candidate.salary_range,
            Candidate.job_status,
            Candidate.expected_city,
            Candidate.skills,
            Candidate.company,
            Candidate.title,
            Candidate.current_company,
            Candidate.current_position,
            Candidate.school,
            Candidate.major,
            Candidate.experience_summary,
            Candidate.raw_snapshot,
            Candidate.source_keyword,
            Candidate.share_url,
            Candidate.created_at,
            Candidate.updated_at,
            Job.title.label("job_title"),
            OutreachRecord.id.label("outreach_id"),
        )
        .order_by(
            # AI 精评分优先(有就用 llm_score,没有回退规则分),统一 0-100 量纲
            desc(func.coalesce(MatchResult.llm_score, MatchResult.score)),
            status_order,
        )
        .all()
    )

    # Dedup by candidate + job. Keep different job matches visible in the
    # all-jobs queue instead of accidentally merging them.
    seen = {}
    items = []
    for row in results:
        (mr, name, active_status, boss_id, age, education, work_years,
         salary_range, job_status, expected_city, skills, company, title,
         current_company, current_position, school, major, experience_summary,
         raw_snapshot, source_keyword, share_url, created_at, updated_at,
         job_title, outreach_id) = row
        key = (mr.candidate_id, mr.job_id)
        if key in seen:
            continue
        seen[key] = True
        items.append(QueueItem(
            match_id=mr.id,
            candidate_id=mr.candidate_id,
            job_id=mr.job_id,
            job_title=job_title or "",
            name=name or "",
            score=mr.score,
            match_reason=mr.match_reason,
            missing_info=mr.missing_info,
            age_pass=mr.age_pass,
            experience_match=mr.experience_match,
            capability_match=mr.capability_match,
            active_status=active_status or "",
            status=mr.status,
            outreach_id=outreach_id,
            llm_score=mr.llm_score,
            llm_reason=mr.llm_reason or "",
            boss_id=boss_id or "",
            age=age,
            education=education or "",
            work_years=work_years or "",
            salary_range=salary_range or "",
            job_status=job_status or "",
            expected_city=expected_city or "",
            skills=skills or "",
            company=company or current_company or "",
            title=title or current_position or "",
            school=school or "",
            major=major or "",
            experience_summary=experience_summary or "",
            raw_snapshot=raw_snapshot or "",
            source_keyword=source_keyword or "",
            share_url=share_url or "",
            created_at=created_at,
            updated_at=updated_at,
        ))

    if limit is not None:
        items = items[:limit]

    return items
