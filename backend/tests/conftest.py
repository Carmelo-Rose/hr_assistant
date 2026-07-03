"""Shared fixtures for API tests."""

import os
import tempfile

# Point the app at an isolated throwaway DB *before* importing it, so a test run
# NEVER touches the real data/boss_hr.db. (The previous fixture reassigned
# engine.url after import — a no-op — and silently ran the whole suite against
# the production DB, dropping its tables on teardown.)
os.environ["BOSS_DB_PATH"] = os.path.join(tempfile.gettempdir(), "boss_hr_test.db")

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.models.database import engine, Base


@pytest.fixture
def client():
    """Fresh isolated DB per test (lifespan reseeds the 4 default jobs)."""
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)
    with TestClient(app) as c:
        yield c
    Base.metadata.drop_all(bind=engine)
