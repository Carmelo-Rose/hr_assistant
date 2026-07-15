import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response

# Load backend/.env into os.environ so config (incl. LLM_* keys) is picked up.
try:
    from dotenv import load_dotenv
    load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env"))
except Exception:
    pass

from sqlalchemy import text

from app.models.database import engine, Base
from app.routers import jobs, candidates, queue, outreach, browser, config, ext

# ── Paths to the userscript and built frontend (served by this backend) ──
ROOT_DIR = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", ".."))
USERSCRIPT_PATH = os.path.join(ROOT_DIR, "userscript", "boss-helper.user.js")
FRONTEND_DIST = os.path.join(ROOT_DIR, "frontend", "dist")
PUBLIC_BASE_URL = os.environ.get("PUBLIC_BASE_URL", "http://localhost:8000").rstrip("/")


def _cors_origins() -> list[str]:
    origins = [
        "http://localhost:5173",
        "http://localhost:3000",
        "https://www.zhipin.com",
    ]
    if PUBLIC_BASE_URL:
        origins.append(PUBLIC_BASE_URL)
    extra = os.environ.get("CORS_ORIGINS", "")
    origins.extend(x.strip().rstrip("/") for x in extra.split(",") if x.strip())
    return sorted(set(origins))


def _migrate_sqlite():
    """Lightweight migrations: add columns that `create_all` won't add to an
    already-existing table. Safe to run on every startup (idempotent)."""
    with engine.begin() as conn:
        cols = {row[1] for row in conn.execute(text("PRAGMA table_info(match_results)"))}
        if "llm_score" not in cols:
            conn.execute(text("ALTER TABLE match_results ADD COLUMN llm_score FLOAT"))
        if "llm_reason" not in cols:
            conn.execute(text("ALTER TABLE match_results ADD COLUMN llm_reason TEXT DEFAULT ''"))

        job_cols = {row[1] for row in conn.execute(text("PRAGMA table_info(jobs)"))}
        added_job_filter_cols = False
        if "age_min" not in job_cols:
            conn.execute(text("ALTER TABLE jobs ADD COLUMN age_min INTEGER DEFAULT 24"))
            added_job_filter_cols = True
        if "min_experience_years" not in job_cols:
            conn.execute(text("ALTER TABLE jobs ADD COLUMN min_experience_years INTEGER DEFAULT 3"))
            added_job_filter_cols = True
        if "salary_min_k" not in job_cols:
            conn.execute(text("ALTER TABLE jobs ADD COLUMN salary_min_k INTEGER DEFAULT 0"))
        if "salary_max_k" not in job_cols:
            conn.execute(text("ALTER TABLE jobs ADD COLUMN salary_max_k INTEGER DEFAULT 0"))
        if "active_requirement" not in job_cols:
            conn.execute(text("ALTER TABLE jobs ADD COLUMN active_requirement VARCHAR(32) DEFAULT 'any'"))
            added_job_filter_cols = True
        if "turnover_frequency" not in job_cols:
            conn.execute(text("ALTER TABLE jobs ADD COLUMN turnover_frequency VARCHAR(32) DEFAULT 'any'"))
        if added_job_filter_cols:
            from app.seed_data import DEFAULT_JOBS

            for job in DEFAULT_JOBS:
                conn.execute(
                    text(
                        """
                        UPDATE jobs
                        SET age_min = :age_min,
                            min_experience_years = :min_experience_years,
                            active_requirement = :active_requirement
                        WHERE id = :id
                        """
                    ),
                    {
                        "id": job["id"],
                        "age_min": job.get("age_min", 0),
                        "min_experience_years": job.get("min_experience_years", 0),
                        "active_requirement": job.get("active_requirement", "any"),
                    },
                )


@asynccontextmanager
async def lifespan(app: FastAPI):
    Base.metadata.create_all(bind=engine)
    _migrate_sqlite()
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
    allow_origins=_cors_origins(),
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
app.include_router(ext.router, prefix="/api/ext")


# ── Serve the Tampermonkey userscript so users install/auto-update from a URL
#    instead of pasting the whole file (see @updateURL/@downloadURL in header). ──
@app.get("/boss-helper.user.js")
def serve_userscript():
    if not os.path.isfile(USERSCRIPT_PATH):
        return Response("userscript not found", status_code=404)
    with open(USERSCRIPT_PATH, "r", encoding="utf-8") as f:
        script = f.read()
    script = script.replace("__BOSS_HELPER_BASE_URL__", PUBLIC_BASE_URL)
    # no-cache so Tampermonkey's update check always sees the latest @version
    return Response(
        script,
        media_type="text/javascript; charset=utf-8",
        headers={"Cache-Control": "no-cache"},
    )


# ── Serve the built frontend (SPA). Registered LAST so /api/* and the
#    userscript route take precedence. Falls back to index.html for client-side
#    routes (e.g. /dashboard, /onboarding) so deep links/refresh work. ──
@app.get("/{full_path:path}")
def serve_spa(full_path: str):
    if full_path.startswith("api/"):
        return Response("Not Found", status_code=404)
    target = os.path.normpath(os.path.join(FRONTEND_DIST, full_path))
    if target.startswith(FRONTEND_DIST) and os.path.isfile(target):
        return FileResponse(target)
    index = os.path.join(FRONTEND_DIST, "index.html")
    if os.path.isfile(index):
        return FileResponse(index)
    return Response(
        "前端尚未构建。请先在 frontend 目录运行 `npm run build`。",
        status_code=404,
        media_type="text/plain; charset=utf-8",
    )
