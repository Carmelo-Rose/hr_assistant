"""Shared fixtures for API tests."""

import pytest
from fastapi.testclient import TestClient

from app.main import app


@pytest.fixture
def client():
    """Use an in-memory SQLite for tests."""
    from app.models.database import engine, Base
    # Override to in-memory
    engine.url = "sqlite:///file::memory:?cache=shared"
    import app.models.database as dbmod
    dbmod.engine = engine
    Base.metadata.create_all(bind=engine)
    with TestClient(app) as c:
        yield c
    Base.metadata.drop_all(bind=engine)