"""Capture candidate from BOSS current page via Playwright + batch search."""

import logging
import re
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.models.database import get_db
from app.models.candidate import Candidate
from app.models.page_snapshot import PageSnapshot
from app.models.match_result import MatchResult
from app.models.job import Job
from app.services.scoring import score_candidate, batch_score_candidate, load_profile
from app.services.browser import get_browser_context
from app.services.boss_scraper import search_candidates, multi_search

logger = logging.getLogger(__name__)
router = APIRouter()


def _parse_age(raw) -> Optional[int]:
    """Parse an int age from scraper strings like '28岁'; None if unparseable."""
    if raw is None:
        return None
    m = re.search(r"(\d+)", str(raw))
    return int(m.group(1)) if m else None


class CaptureResult(BaseModel):
    candidate_id: int
    name: str
    match_count: int
    matches: list[dict]


class BatchSearchResult(BaseModel):
    total: int
    candidates: list[dict]
    stats: dict


class BatchScoreResult(BaseModel):
    results: list[dict]


async def extract_from_page(page) -> dict:
    """Extract candidate fields from BOSS 详情页 DOM."""
    result = await page.evaluate("""() => {
        const doc = document;
        const text = doc.body.innerText;

        const g = (sel) => {
            const el = doc.querySelector(sel);
            return el ? el.innerText.trim() : '';
        };

        const name = g('.name-text') || g('[class*="name"]') || doc.title.replace(' - 招聘', '').split('-')[0]?.trim() || '';
        const ageText = g('.age-text') || g('[class*="age"]') || '';
        const age = ageText.match(/(\\d+)/)?.[1] ? parseInt(ageText.match(/(\\d+)/)[1]) : null;
        const gender = (g('.gender-text') || g('[class*="gender"]') || '').trim();
        const education = g('.education-text') || g('[class*="education"]') || '';
        const school = g('.school-text') || g('[class*="school"]') || '';
        const workYears = g('.work-year-text') || g('[class*="work-year"]') || g('[class*="exp"]') || '';
        const company = g('.company-text') || g('[class*="company"]') || '';
        const position = g('.position-text') || g('[class*="position"][class*="current"]') || '';
        const activeStatus = g('.active-status') || g('[class*="active"]') || '';

        const expSection = doc.querySelector('[class*="experience"]') || doc.querySelector('[class*="work-experience"]');
        const experienceSummary = expSection ? expSection.innerText.trim() : '';

        const skillEls = doc.querySelectorAll('[class*="tag"] [class*="skill"], [class*="skill-tag"], [class*="tag-item"]');
        const skills = Array.from(skillEls).map(el => el.innerText.trim()).filter(Boolean).join(', ');

        return {
            name, age, gender, education, school,
            workYears, company, position, activeStatus,
            experienceSummary, skills,
            rawText: text.substring(0, 8000),
            url: window.location.href,
        };
    }""")
    return result


@router.post("/candidates/capture-current")
async def capture_current(db: Session = Depends(get_db)):
    ctx, msg = get_browser_context()
    if not ctx:
        raise HTTPException(status_code=400, detail=msg)

    page = ctx.pages[-1] if ctx.pages else await ctx.new_page()
    data = await extract_from_page(page)

    boss_id = data.get("url", "").split("/")[-2] if "/" in data.get("url", "") else "unknown"
    if len(boss_id) < 4:
        boss_id = f"page_{data['url'].split('/')[-1] or 'unknown'}"

    existing = db.query(Candidate).filter(Candidate.boss_id == boss_id).first()
    if existing:
        candidate = existing
        for k, v in [
            ("name", data.get("name", "")),
            ("age", data.get("age")),
            ("gender", data.get("gender", "")),
            ("education", data.get("education", "")),
            ("school", data.get("school", "")),
            ("work_years", data.get("workYears", "")),
            ("current_company", data.get("company", "")),
            ("current_position", data.get("position", "")),
            ("experience_summary", data.get("experienceSummary", "")),
            ("skills", data.get("skills", "")),
            ("active_status", data.get("activeStatus", "")),
            ("raw_snapshot", data.get("rawText", "")),
        ]:
            if v:
                setattr(candidate, k, v)
    else:
        candidate = Candidate(
            boss_id=boss_id,
            name=data.get("name", ""),
            age=data.get("age"),
            gender=data.get("gender", ""),
            education=data.get("education", ""),
            school=data.get("school", ""),
            work_years=data.get("workYears", ""),
            current_company=data.get("company", ""),
            current_position=data.get("position", ""),
            experience_summary=data.get("experienceSummary", ""),
            skills=data.get("skills", ""),
            active_status=data.get("activeStatus", ""),
            raw_snapshot=data.get("rawText", ""),
        )
        db.add(candidate)
    db.commit()
    db.refresh(candidate)

    snap = PageSnapshot(
        candidate_id=candidate.id,
        raw_html="",
        raw_text=data.get("rawText", ""),
        url=data.get("url", ""),
    )
    db.add(snap)

    jobs = db.query(Job).all()
    matches = []
    for job in jobs:
        result = score_candidate(candidate, job)
        mr = MatchResult(
            candidate_id=candidate.id,
            job_id=job.id,
            score=result["score"],
            match_reason=result["match_reason"],
            missing_info=result["missing_info"],
            age_pass=result["age_pass"],
            experience_match=result["experience_match"],
            capability_match=result["capability_match"],
        )
        db.add(mr)
        matches.append({
            "job_id": job.id,
            "job_title": job.title,
            "score": result["score"],
            "match_reason": result["match_reason"],
            "missing_info": result["missing_info"],
        })
    db.commit()

    return CaptureResult(
        candidate_id=candidate.id,
        name=candidate.name,
        match_count=len(matches),
        matches=matches,
    )


class BatchSearchRequest(BaseModel):
    keywords: list[str] | None = None
    city: str = ""
    count_per_keyword: int = 50


@router.post("/candidates/batch-search")
async def batch_search_candidates(
    req: BatchSearchRequest,
    db: Session = Depends(get_db),
):
    """多关键词批量搜索候选人，自动去重。

    从 YAML 配置读取关键词（或手动传入），在 BOSS 招聘者后台搜索，
    自动去重并存入 candidates 表。
    """
    profile = load_profile()
    keywords = req.keywords or profile.get("keywords", [])
    city = req.city or profile.get("job", {}).get("city", "")
    count = req.count_per_keyword or 50

    if not keywords:
        raise HTTPException(status_code=400, detail="无搜索关键词，请配置 search_profile.yaml 或传入 keywords")

    ctx, msg = get_browser_context()
    if not ctx:
        raise HTTPException(status_code=400, detail=f"浏览器未连接: {msg}")

    raw_candidates = await multi_search(keywords, city, count)

    if raw_candidates and "error" in raw_candidates[0]:
        raise HTTPException(status_code=500, detail=raw_candidates[0]["error"])

    # Score & store
    scored = []
    new_count = 0
    for c in raw_candidates:
        score_result = batch_score_candidate(c, profile)
        c["_score"] = score_result["score"]
        c["_details"] = score_result["details"]
        c["_blocked"] = score_result["is_blocked"]
        scored.append(c)

        expect_id = c.get("expectId", "") or c.get("name", "")
        if not expect_id:
            continue

        existing = db.query(Candidate).filter(
            Candidate.boss_id == expect_id
        ).first()
        if existing:
            existing.salary_range = c.get("salary", existing.salary_range)
            existing.job_status = c.get("jobStatus", existing.job_status)
            existing.expected_city = c.get("expectCity", existing.expected_city)
            existing.company = c.get("company", existing.company)
            existing.title = c.get("title", existing.title)
            existing.major = c.get("major", existing.major)
            parsed_age = _parse_age(c.get("age"))
            if parsed_age is not None:
                existing.age = parsed_age
            if c.get("fullText"):
                existing.experience_summary = c.get("fullText", "")
            existing.score = score_result["score"]
            existing.source_keyword = c.get("_source_keyword", existing.source_keyword)
            continue

        name = c.get("name", "")
        candidate = Candidate(
            boss_id=expect_id,
            expect_id=expect_id,
            name=name or "未知",
            age=_parse_age(c.get("age")),
            education=c.get("education", ""),
            school=c.get("school", ""),
            work_years=c.get("experience", ""),
            current_company=c.get("company", ""),
            current_position=c.get("title", ""),
            experience_summary=c.get("fullText", ""),
            skills=", ".join(c.get("skills", [])),
            raw_snapshot=c.get("fullText", ""),
            salary_range=c.get("salary", ""),
            job_status=c.get("jobStatus", ""),
            expected_city=c.get("expectCity", ""),
            major=c.get("major", ""),
            score=score_result["score"],
            source_keyword=c.get("_source_keyword", ""),
        )
        db.add(candidate)
        new_count += 1

    db.commit()

    # Sort by score desc
    scored.sort(key=lambda x: x["_score"], reverse=True)
    top = [c for c in scored if not c["_blocked"]][:20]

    return {
        "total_fetched": len(raw_candidates),
        "new_candidates": new_count,
        "total_in_db": db.query(Candidate).count(),
        "top_candidates": [
            {
                "expectId": c.get("expectId", ""),
                "name": c.get("name", ""),
                "score": c["_score"],
                "details": c["_details"],
                "age": c.get("age", ""),
                "education": c.get("education", ""),
                "salary": c.get("salary", ""),
                "experience": c.get("experience", ""),
                "company": c.get("company", ""),
                "title": c.get("title", ""),
                "jobStatus": c.get("jobStatus", ""),
                "skills": c.get("skills", []),
                "fullText": c.get("fullText", "")[:300],
            }
            for c in top
        ],
    }


class ScoreRequest(BaseModel):
    expect_ids: list[str] | None = None


@router.post("/candidates/batch-score")
def batch_score_endpoint(
    req: ScoreRequest,
    db: Session = Depends(get_db),
):
    """对数据库中候选人进行批量评分（基于 YAML 配置）。"""
    profile = load_profile()
    query = db.query(Candidate)

    if req.expect_ids:
        query = query.filter(Candidate.expect_id.in_(req.expect_ids))

    candidates = query.all()
    results = []
    for c in candidates:
        candidate_dict = {
            "fullText": c.raw_snapshot or "",
            "skills": (c.skills or "").split(", "),
            "education": c.education or "",
            "salary": c.salary_range or "",
            "experience": c.work_years or "",
            "jobStatus": c.job_status or "",
            "age": c.age or "",
            "company": c.company or "",
            "title": c.title or "",
        }
        sr = batch_score_candidate(candidate_dict, profile)
        results.append({
            "candidate_id": c.id,
            "name": c.name,
            "expect_id": c.expect_id,
            "score": sr["score"],
            "blocked": sr["is_blocked"],
            "details": sr["details"],
        })

    results.sort(key=lambda x: x["score"], reverse=True)
    return {"results": results}


class EnqueueRequest(BaseModel):
    expect_id: str
    job_id: str


@router.post("/candidates/enqueue")
def enqueue_candidate(req: EnqueueRequest, db: Session = Depends(get_db)):
    """Add a batch-scored candidate to the outreach queue."""
    candidate = db.query(Candidate).filter(Candidate.expect_id == req.expect_id).first()
    if not candidate:
        raise HTTPException(status_code=404, detail="Candidate not found")

    job = db.query(Job).filter(Job.id == req.job_id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    # Check existing match
    existing = db.query(MatchResult).filter(
        MatchResult.candidate_id == candidate.id,
        MatchResult.job_id == job.id,
    ).first()
    if existing:
        existing.status = "queued"
        db.commit()
        return {"match_id": existing.id, "status": "queued", "created": False}

    # Score if not already scored
    result = score_candidate(candidate, job)

    mr = MatchResult(
        candidate_id=candidate.id,
        job_id=job.id,
        score=result["score"],
        match_reason=result["match_reason"],
        missing_info=result["missing_info"],
        age_pass=result["age_pass"],
        experience_match=result["experience_match"],
        capability_match=result["capability_match"],
        status="queued",
        is_queued=1,
    )
    db.add(mr)
    db.commit()
    db.refresh(mr)
    return {"match_id": mr.id, "status": "queued", "created": True}