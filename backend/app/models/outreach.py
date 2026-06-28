from sqlalchemy import Column, String, Integer, Text, DateTime, ForeignKey
from datetime import datetime, timezone

from app.models.database import Base


class OutreachRecord(Base):
    __tablename__ = "outreach_records"

    id = Column(Integer, primary_key=True, autoincrement=True)
    match_id = Column(Integer, ForeignKey("match_results.id"), nullable=False)
    candidate_id = Column(Integer, ForeignKey("candidates.id"), nullable=False)
    job_id = Column(String(64), ForeignKey("jobs.id"), nullable=False)
    draft_text = Column(Text, default="")
    status = Column(String(32), default="drafted")  # drafted | filled | sent_manual | skipped
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))