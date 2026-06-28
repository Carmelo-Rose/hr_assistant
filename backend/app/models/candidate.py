from sqlalchemy import Column, String, Integer, Text, DateTime, Float
from datetime import datetime, timezone

from app.models.database import Base


class Candidate(Base):
    __tablename__ = "candidates"

    id = Column(Integer, primary_key=True, autoincrement=True)
    boss_id = Column(String(128), unique=True, nullable=False, index=True)
    name = Column(String(64), default="")
    age = Column(Integer, nullable=True)
    gender = Column(String(8), default="")
    education = Column(String(64), default="")
    school = Column(String(128), default="")
    work_years = Column(String(32), default="")
    current_company = Column(String(128), default="")
    current_position = Column(String(128), default="")
    experience_summary = Column(Text, default="")
    skills = Column(Text, default="")
    active_status = Column(String(32), default="")
    raw_snapshot = Column(Text, default="")

    # 新增: 批量采集扩展字段
    expect_id = Column(String(128), default="", index=True)
    salary_range = Column(String(64), default="")
    job_status = Column(String(32), default="")
    expected_city = Column(String(64), default="")
    company = Column(String(128), default="")
    title = Column(String(128), default="")
    major = Column(String(64), default="")
    score = Column(Float, nullable=True)
    notes = Column(Text, default="")
    share_url = Column(Text, default="")
    source_keyword = Column(String(64), default="")

    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))