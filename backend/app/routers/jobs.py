from typing import List

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
    age_max: int
    experience_keywords: str
    capability_keywords: str
    active_hours: str
    template: str

    class Config:
        from_attributes = True


class JobPatch(BaseModel):
    title: str | None = None
    department: str | None = None
    age_max: int | None = None
    experience_keywords: str | None = None
    capability_keywords: str | None = None
    active_hours: str | None = None
    template: str | None = None


@router.get("/jobs", response_model=List[JobOut])
def list_jobs(db: Session = Depends(get_db)):
    return db.query(Job).all()


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