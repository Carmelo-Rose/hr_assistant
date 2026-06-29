"""Browser management: start persistent Chromium and check status."""

import os
from fastapi import APIRouter
from pydantic import BaseModel

from app.services.browser import start_browser, get_browser_context, stop_browser

router = APIRouter()


class BrowserStartRequest(BaseModel):
    user_data_dir: str = ""
    headless: bool = False


class BrowserStatus(BaseModel):
    running: bool
    page_count: int = 0
    message: str = ""


@router.post("/browser/start")
async def start(req: BrowserStartRequest):
    user_data_dir = req.user_data_dir or os.path.join(
        os.path.dirname(__file__), "..", "..", "data", "browser_profile"
    )
    ok, msg, warning = await start_browser(user_data_dir=user_data_dir, headless=req.headless)
    resp = {"success": ok, "message": msg}
    if warning:
        resp["warning"] = warning
    return resp


@router.get("/browser/status", response_model=BrowserStatus)
def status():
    ctx, msg = get_browser_context()
    if ctx:
        page_count = len(ctx.pages)
        return BrowserStatus(running=True, page_count=page_count, message=msg)
    return BrowserStatus(running=False, message=msg)