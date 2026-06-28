"""Outreach: draft, fill into BOSS input box, and status updates."""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.models.database import get_db
from app.models.match_result import MatchResult
from app.models.outreach import OutreachRecord
from app.models.candidate import Candidate
from app.models.job import Job
from app.services.templating import render_draft
from app.services.browser import get_browser_context

router = APIRouter()


class OutreachStatusPatch(BaseModel):
    status: str  # sent_manual | skipped


@router.post("/outreach/{match_id}/draft")
def create_draft(match_id: int, db: Session = Depends(get_db)):
    """Generate draft text for a match result and create/find outreach record."""
    mr = db.query(MatchResult).filter(MatchResult.id == match_id).first()
    if not mr:
        raise HTTPException(status_code=404, detail="MatchResult not found")

    candidate = db.query(Candidate).filter(Candidate.id == mr.candidate_id).first()
    job = db.query(Job).filter(Job.id == mr.job_id).first()
    if not candidate or not job:
        raise HTTPException(status_code=404, detail="Candidate or Job not found")

    draft = render_draft(candidate, job)

    existing = db.query(OutreachRecord).filter(
        OutreachRecord.match_id == match_id,
        OutreachRecord.candidate_id == mr.candidate_id,
        OutreachRecord.job_id == mr.job_id,
    ).first()

    if existing:
        existing.draft_text = draft
        record = existing
    else:
        record = OutreachRecord(
            match_id=match_id,
            candidate_id=mr.candidate_id,
            job_id=mr.job_id,
            draft_text=draft,
        )
        db.add(record)

    mr.status = "drafted"
    db.commit()
    db.refresh(record)

    return {
        "outreach_id": record.id,
        "match_id": match_id,
        "draft_text": draft,
        "status": "drafted",
    }


@router.post("/outreach/{match_id}/fill")
async def fill_chat_box(match_id: int, db: Session = Depends(get_db)):
    """
    Fill the generated draft text into the BOSS chat input box.
    Does NOT click send.
    """
    mr = db.query(MatchResult).filter(MatchResult.id == match_id).first()
    if not mr:
        raise HTTPException(status_code=404, detail="MatchResult not found")

    record = db.query(OutreachRecord).filter(
        OutreachRecord.match_id == match_id,
    ).order_by(OutreachRecord.id.desc()).first()

    if not record or not record.draft_text:
        raise HTTPException(status_code=400, detail="No draft found; call /draft first")

    ctx, msg = get_browser_context()
    if not ctx:
        raise HTTPException(status_code=400, detail=msg)

    page = ctx.pages[-1] if ctx.pages else await ctx.new_page()

    # Escape draft text for JS injection
    import json
    escaped = json.dumps(record.draft_text, ensure_ascii=False)

    filled = await page.evaluate(f"""() => {{
        // Common BOSS chat input selectors
        const inputSelectors = [
            'textarea[class*="chat-input"]',
            'textarea[class*="message-input"]',
            'div[class*="chat"] textarea',
            'div[class*="message"] textarea',
            'textarea[placeholder*="说"]',
            'textarea[placeholder*="输入"]',
            '[contenteditable="true"][class*="chat"]',
            '[contenteditable="true"][class*="message"]',
            '[class*="chat-input"] [contenteditable="true"]',
            '[class*="input-area"] [contenteditable="true"]',
        ];

        for (const sel of inputSelectors) {{
            const el = document.querySelector(sel);
            if (el) {{
                const tag = el.tagName.toLowerCase();
                if (tag === 'textarea' || tag === 'input') {{
                    el.value = {escaped};
                    el.dispatchEvent(new Event('input', {{ bubbles: true }}));
                    el.dispatchEvent(new Event('change', {{ bubbles: true }}));
                }} else if (el.getAttribute('contenteditable') === 'true') {{
                    el.textContent = {escaped};
                    el.dispatchEvent(new Event('input', {{ bubbles: true }}));
                    el.dispatchEvent(new Event('change', {{ bubbles: true }}));
                }}
                return true;
            }}
        }}
        return false;
    }}""")

    if filled:
        record.status = "filled"
        mr.status = "filled"
        db.commit()

    return {
        "outreach_id": record.id,
        "filled": filled,
        "message": "话术已填入输入框，请人工检查后手动发送" if filled else "未找到输入框",
    }


@router.patch("/outreach/{match_id}/status")
def update_outreach_status(match_id: int, patch: OutreachStatusPatch, db: Session = Depends(get_db)):
    """Mark outreach as sent_manual or skipped."""
    valid = {"sent_manual", "skipped"}
    if patch.status not in valid:
        raise HTTPException(status_code=400, detail=f"Status must be one of {valid}")

    mr = db.query(MatchResult).filter(MatchResult.id == match_id).first()
    if not mr:
        raise HTTPException(status_code=404, detail="MatchResult not found")

    mr.status = patch.status
    record = db.query(OutreachRecord).filter(
        OutreachRecord.match_id == match_id,
    ).order_by(OutreachRecord.id.desc()).first()
    if record:
        record.status = patch.status
    db.commit()

    return {"match_id": match_id, "status": patch.status}