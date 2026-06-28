from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.models.database import engine, Base
from app.routers import jobs, candidates, queue, outreach, browser, config


@asynccontextmanager
async def lifespan(app: FastAPI):
    Base.metadata.create_all(bind=engine)
    from app.models.database import SessionLocal
    from app.models.job import Job
    db = SessionLocal()
    try:
        if db.query(Job).count() == 0:
            _seed_jobs(db)
    finally:
        db.close()
    yield


def _seed_jobs(db):
    from app.models.job import Job
    from app.seed_data import DEFAULT_JOBS
    for d in DEFAULT_JOBS:
        db.add(Job(**d))
    db.commit()


app = FastAPI(title="BOSS HR Assistant", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(jobs.router, prefix="/api")
app.include_router(candidates.router, prefix="/api")
app.include_router(queue.router, prefix="/api")
app.include_router(outreach.router, prefix="/api")
app.include_router(browser.router, prefix="/api")
app.include_router(config.router, prefix="/api")