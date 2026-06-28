from sqlalchemy import Column, String, Integer, Text, DateTime, ForeignKey
from datetime import datetime, timezone

from app.models.database import Base


class PageSnapshot(Base):
    __tablename__ = "page_snapshots"

    id = Column(Integer, primary_key=True, autoincrement=True)
    candidate_id = Column(Integer, ForeignKey("candidates.id"), nullable=False)
    raw_html = Column(Text, default="")
    raw_text = Column(Text, default="")
    url = Column(Text, default="")
    captured_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))