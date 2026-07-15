from typing import List
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.models.database import get_db
from app.models.job import Job

router = APIRouter()


class JobOut(BaseModel):
    id: str
    title: str
    department: str
    age_min: int = 0
    age_max: int
    salary_min_k: int = 0
    salary_max_k: int = 0
    min_experience_years: int = 0
    experience_keywords: str
    capability_keywords: str
    active_requirement: str = "any"
    turnover_frequency: str = "any"
    active_hours: str
    template: str

    class Config:
        from_attributes = True


class JobPatch(BaseModel):
    title: str | None = None
    department: str | None = None
    age_min: int | None = None
    age_max: int | None = None
    salary_min_k: int | None = None
    salary_max_k: int | None = None
    min_experience_years: int | None = None
    experience_keywords: str | None = None
    capability_keywords: str | None = None
    active_requirement: str | None = None
    turnover_frequency: str | None = None
    active_hours: str | None = None
    template: str | None = None


class JobCreate(BaseModel):
    title: str
    department: str = ""
    age_min: int = 24
    age_max: int = 38
    salary_min_k: int = 0
    salary_max_k: int = 0
    min_experience_years: int = 3
    experience_keywords: str = ""
    capability_keywords: str = ""
    active_requirement: str = "3d"
    turnover_frequency: str = "any"
    active_hours: str = "09:00-18:00"
    template: str = ""


@router.get("/jobs", response_model=List[JobOut])
def list_jobs(db: Session = Depends(get_db)):
    return db.query(Job).all()


@router.post("/jobs", response_model=JobOut)
def create_job(payload: JobCreate, db: Session = Depends(get_db)):
    title = payload.title.strip()
    if not title:
        raise HTTPException(status_code=400, detail="Job title is required")

    job = Job(
        id=f"job-custom-{uuid4().hex[:8]}",
        title=title,
        department=payload.department,
        age_min=payload.age_min,
        age_max=payload.age_max,
        salary_min_k=payload.salary_min_k,
        salary_max_k=payload.salary_max_k,
        min_experience_years=payload.min_experience_years,
        experience_keywords=payload.experience_keywords,
        capability_keywords=payload.capability_keywords,
        active_requirement=payload.active_requirement,
        turnover_frequency=payload.turnover_frequency,
        active_hours=payload.active_hours,
        template=payload.template,
    )
    db.add(job)
    db.commit()
    db.refresh(job)
    return job


@router.patch("/jobs/{job_id}", response_model=JobOut)
def patch_job(job_id: str, patch: JobPatch, db: Session = Depends(get_db)):
    job = db.query(Job).filter(Job.id == job_id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    for field, value in patch.model_dump(exclude_none=True).items():
        setattr(job, field, value)
    db.commit()
    db.refresh(job)
    return job
