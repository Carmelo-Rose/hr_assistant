from sqlalchemy import Column, String, Integer, Text
from app.models.database import Base


class Job(Base):
    __tablename__ = "jobs"

    id = Column(String(64), primary_key=True)
    title = Column(String(128), nullable=False)
    department = Column(String(128), default="")
    age_max = Column(Integer, default=99)
    experience_keywords = Column(Text, default="")   # comma-separated
    capability_keywords = Column(Text, default="")     # comma-separated
    active_hours = Column(String(32), default="09:00-18:00")
    template = Column(Text, default="")