"""
No-LLM templating engine: replace {variables} in job templates with candidate data.
"""

import re
from typing import Optional

from app.models.candidate import Candidate
from app.models.job import Job
from app.services.scoring import extract_work_years_int


def render_draft(candidate: Candidate, job: Job) -> str:
    """Render job.template with candidate fields."""
    work_years = extract_work_years_int(candidate.work_years) or ""

    # Pick the first matched capability keyword as key_skill
    cap_raw = job.capability_keywords or ""
    cap_kws = [kw.strip() for kw in cap_raw.split(",") if kw.strip()]
    key_skill = ""
    if cap_kws and candidate.skills:
        skills_lower = candidate.skills.lower()
        for kw in cap_kws:
            if kw.lower() in skills_lower:
                key_skill = kw
                break
    if not key_skill and candidate.current_position:
        key_skill = candidate.current_position

    vars_map = {
        "name": candidate.name or "候选人",
        "job_title": job.title or "",
        "department": job.department or "",
        "experience_years": str(work_years) if work_years else "多年",
        "key_skill": key_skill or "相关技能",
        "current_company": candidate.current_company or "",
        "current_position": candidate.current_position or "",
        "education": candidate.education or "",
    }

    text = job.template or ""
    for k, v in vars_map.items():
        text = text.replace("{" + k + "}", v)

    return text