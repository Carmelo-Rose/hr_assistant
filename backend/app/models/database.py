import os

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, declarative_base

DB_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "data")
os.makedirs(DB_DIR, exist_ok=True)
# DATABASE_URL is the production PostgreSQL connection string. BOSS_DB_PATH
# remains as the isolated SQLite fallback used by tests and local development.
DB_PATH = os.environ.get("BOSS_DB_PATH") or os.path.join(DB_DIR, "boss_hr.db")
DATABASE_URL = os.environ.get("DATABASE_URL") or f"sqlite:///{DB_PATH}"
SQLALCHEMY_DATABASE_URL = (
    DATABASE_URL.replace("postgresql://", "postgresql+psycopg://", 1)
    if DATABASE_URL.startswith("postgresql://")
    else DATABASE_URL
)

engine_options = {"echo": False, "pool_pre_ping": True}
if SQLALCHEMY_DATABASE_URL.startswith("sqlite:"):
    engine_options["connect_args"] = {"check_same_thread": False}

engine = create_engine(SQLALCHEMY_DATABASE_URL, **engine_options)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
