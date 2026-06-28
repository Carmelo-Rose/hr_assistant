"""Today's outreach queue."""

from typing import Optional

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session
from sqlalchemy import desc

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


@router.get("/queue/today")
def get_today_queue(
    job_id: Optional[str] = Query(None),
    status_filter: Optional[str] = Query(None),
    db: Session = Depends(get_db),
):
    """
    Build today's queue:
    - For each MatchResult that is NOT sent_manual/skipped, or if already queued
    - Order by: score desc, active_status bonus, completeness
    - Dedup by candidate_id (pick best score first)
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
            Job.title.label("job_title"),
            OutreachRecord.id.label("outreach_id"),
        )
        .order_by(
            desc(MatchResult.score),
            status_order,
        )
        .all()
    )

    # Dedup by candidate_id (keep highest score)
    seen = {}
    items = []
    for row in results:
        mr, name, active_status, job_title, outreach_id = row
        cid = mr.candidate_id
        if cid in seen:
            continue
        seen[cid] = True
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
        ))

    return items