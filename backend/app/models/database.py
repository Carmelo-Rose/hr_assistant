import os

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, declarative_base

DB_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "data")
os.makedirs(DB_DIR, exist_ok=True)
# BOSS_DB_PATH lets tests (and packaging) point at an isolated DB instead of the
# real data/boss_hr.db. Tests MUST set this so a test run never touches real data.
DB_PATH = os.environ.get("BOSS_DB_PATH") or os.path.join(DB_DIR, "boss_hr.db")

engine = create_engine(f"sqlite:///{DB_PATH}", echo=False, connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()