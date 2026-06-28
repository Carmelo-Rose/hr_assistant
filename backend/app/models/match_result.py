from sqlalchemy import Column, String, Integer, Text, Float, DateTime, ForeignKey
from datetime import datetime, timezone

from app.models.database import Base


class MatchResult(Base):
    __tablename__ = "match_results"

    id = Column(Integer, primary_key=True, autoincrement=True)
    candidate_id = Column(Integer, ForeignKey("candidates.id"), nullable=False)
    job_id = Column(String(64), ForeignKey("jobs.id"), nullable=False)
    score = Column(Float, default=0.0)
    match_reason = Column(Text, default="")
    missing_info = Column(Text, default="")    # comma-separated risk fields
    age_pass = Column(Integer, default=0)
    experience_match = Column(Integer, default=0)
    capability_match = Column(Integer, default=0)
    is_queued = Column(Integer, default=0)
    status = Column(String(32), default="new")  # new | queued | drafted | filled | sent_manual | skipped
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))