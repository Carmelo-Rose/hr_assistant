"""Expose search_profile.yaml so the frontend has a single source of truth
for default keywords / city / filters instead of hardcoding them.
"""

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.services.scoring import load_profile
from app.models.database import get_db
from app.models.candidate import Candidate
from app.models.match_result import MatchResult
from app.models.outreach import OutreachRecord
from app.models.page_snapshot import PageSnapshot

router = APIRouter()


@router.get("/config/profile")
def get_profile():
    """Return the parsed search_profile.yaml (keywords, job.city, filter, scoring)."""
    return load_profile()


@router.delete("/config/reset-db")
def reset_db(db: Session = Depends(get_db)):
    """清空候选人 / 匹配 / 触达 / 页面快照数据，岗位配置(Job)保留不动。"""
    counts = {
        "candidates": db.query(Candidate).delete(synchronize_session=False),
        "match_results": db.query(MatchResult).delete(synchronize_session=False),
        "outreach_records": db.query(OutreachRecord).delete(synchronize_session=False),
        "page_snapshots": db.query(PageSnapshot).delete(synchronize_session=False),
    }
    db.commit()
    return {"deleted": counts}
