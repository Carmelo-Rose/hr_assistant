from sqlalchemy import Column, String, Integer, Text
from app.models.database import Base


class Job(Base):
    __tablename__ = "jobs"

    id = Column(String(64), primary_key=True)
    title = Column(String(128), nullable=False)
    department = Column(String(128), default="")
    age_min = Column(Integer, default=24)
    age_max = Column(Integer, default=38)
    salary_min_k = Column(Integer, default=0)  # monthly salary floor, in K
    salary_max_k = Column(Integer, default=0)  # monthly salary ceiling, in K
    min_experience_years = Column(Integer, default=3)
    experience_keywords = Column(Text, default="")   # comma-separated
    capability_keywords = Column(Text, default="")     # comma-separated
    active_requirement = Column(String(32), default="any")
    turnover_frequency = Column(String(32), default="any")
    active_hours = Column(String(32), default="09:00-18:00")
    template = Column(Text, default="")
