"""Shared ingestion logic: upsert a Candidate row from scraper dict + score result.

Used by both the Playwright batch-search path and the userscript ext/score path.
"""

import re
from typing import Optional

from sqlalchemy.orm import Session

from app.models.candidate import Candidate


def _parse_age(raw) -> Optional[int]:
    if raw is None:
        return None
    m = re.search(r"(\d+)", str(raw))
    return int(m.group(1)) if m else None


def upsert_candidate(
    db: Session,
    candidate_dict: dict,
    score_result: dict,
    source_keyword: str = "",
    *,
    commit: bool = True,
) -> Candidate:
    """Upsert a Candidate from a scraper dict (EXTRACT_CARDS_JS shape).

    - If boss_id/expectId already exists, update mutable fields.
    - Otherwise insert a new row.
    - Returns the persisted Candidate object (refreshed).
    """
    expect_id = candidate_dict.get("expectId", "") or candidate_dict.get("name", "")
    if not expect_id:
        # Fallback: use name + index as a pseudo-ID so we still persist
        expect_id = candidate_dict.get("name", "unknown")

    existing = db.query(Candidate).filter(
        Candidate.boss_id == expect_id
    ).first()

    if existing:
        # Update mutable fields only. Refresh every presentation field on each
        # rescan (not just salary/city/etc) so a candidate captured under a
        # stale card-extraction bug self-heals once the userscript is fixed,
        # instead of keeping bad data forever because only a subset refreshed.
        if candidate_dict.get("name"):
            existing.name = candidate_dict["name"]
        existing.active_status = candidate_dict.get("activeStatus", existing.active_status)
        existing.education = candidate_dict.get("education", existing.education)
        existing.work_years = candidate_dict.get("experience", existing.work_years)
        existing.skills = ", ".join(candidate_dict.get("skills", [])) or existing.skills
        existing.salary_range = candidate_dict.get("salary", existing.salary_range)
        existing.job_status = candidate_dict.get("jobStatus", existing.job_status)
        existing.expected_city = candidate_dict.get("expectCity", existing.expected_city)
        existing.company = candidate_dict.get("company", existing.company)
        existing.title = candidate_dict.get("title", existing.title)
        existing.major = candidate_dict.get("major", existing.major)
        parsed_age = _parse_age(candidate_dict.get("age"))
        if parsed_age is not None:
            existing.age = parsed_age
        if candidate_dict.get("fullText"):
            existing.experience_summary = candidate_dict.get("fullText", "")
        if candidate_dict.get("shareUrl"):
            existing.share_url = candidate_dict["shareUrl"]
        existing.score = score_result["score"]
        if source_keyword:
            existing.source_keyword = source_keyword
        candidate = existing
    else:
        candidate = Candidate(
            boss_id=expect_id,
            expect_id=expect_id,
            name=candidate_dict.get("name", "") or "未知",
            age=_parse_age(candidate_dict.get("age")),
            active_status=candidate_dict.get("activeStatus", ""),
            education=candidate_dict.get("education", ""),
            school=candidate_dict.get("school", ""),
            work_years=candidate_dict.get("experience", ""),
            current_company=candidate_dict.get("company", ""),
            current_position=candidate_dict.get("title", ""),
            experience_summary=candidate_dict.get("fullText", ""),
            skills=", ".join(candidate_dict.get("skills", [])),
            raw_snapshot=candidate_dict.get("fullText", ""),
            salary_range=candidate_dict.get("salary", ""),
            job_status=candidate_dict.get("jobStatus", ""),
            expected_city=candidate_dict.get("expectCity", ""),
            major=candidate_dict.get("major", ""),
            score=score_result["score"],
            share_url=candidate_dict.get("shareUrl", ""),
            source_keyword=source_keyword,
        )
        db.add(candidate)

    if commit:
        db.commit()
        db.refresh(candidate)
    else:
        # Flush assigns the primary key for new candidates while keeping the
        # caller's larger replace operation inside one transaction.
        db.flush()
    return candidate
