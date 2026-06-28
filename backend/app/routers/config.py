"""Expose search_profile.yaml so the frontend has a single source of truth
for default keywords / city / filters instead of hardcoding them.
"""

from fastapi import APIRouter

from app.services.scoring import load_profile

router = APIRouter()


@router.get("/config/profile")
def get_profile():
    """Return the parsed search_profile.yaml (keywords, job.city, filter, scoring)."""
    return load_profile()
