"""Scoring engine: rule-based + multi-dimension scoring.

Two modes:
1. match_candidate(candidate, job) — 一对一匹配（原有逻辑增强）
2. batch_score(candidates, profile) — 批量评分（YAML 配置驱动）
"""

import re
import os
from typing import Optional

import yaml

from app.models.job import Job
from app.models.candidate import Candidate

CONFIG_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "config")
PROFILE_PATH = os.path.join(CONFIG_DIR, "search_profile.yaml")


def load_profile() -> dict:
    if os.path.exists(PROFILE_PATH):
        with open(PROFILE_PATH, "r", encoding="utf-8") as f:
            return yaml.safe_load(f) or {}
    return {}


# --- Mode 1: One-to-one matching (keeps original API) ---

def score_candidate(candidate: Candidate, job: Job) -> dict:
    score = 0
    match_reasons = []
    missing_info = []
    experience_match = 0
    capability_match = 0

    # --- Age check ---
    age_pass = 1
    if candidate.age is not None and job.age_max:
        if candidate.age <= job.age_max:
            score += 20
            match_reasons.append(f"年龄{candidate.age}岁，符合≤{job.age_max}岁要求")
        else:
            age_pass = 0
            match_reasons.append(f"年龄{candidate.age}岁，超出{job.age_max}岁上限")
            missing_info.append("年龄超出上限")
    elif candidate.age is None:
        age_pass = 0
        missing_info.append("年龄未知")
    else:
        score += 20

    # --- Salary range ---
    salary_min_k = max(0, getattr(job, "salary_min_k", 0) or 0)
    salary_max_k = getattr(job, "salary_max_k", 0) or 0
    if salary_min_k or salary_max_k:
        salary_max_k = max(salary_min_k, salary_max_k or 999)
        candidate_salary = _parse_salary_range_k(candidate.salary_range)
        if candidate_salary is None:
            missing_info.append("薪资未知")
        elif candidate_salary[1] < salary_min_k or candidate_salary[0] > salary_max_k:
            missing_info.append("薪资不在职位区间")
        else:
            score += 5
            match_reasons.append(
                f"薪资匹配: {candidate.salary_range}，职位{salary_min_k}-{salary_max_k}K"
            )

    # --- Experience keywords ---
    exp_raw = job.experience_keywords or ""
    exp_kws = [kw.strip() for kw in exp_raw.split(",") if kw.strip()]
    _exp = candidate.experience_summary or ""
    _pos = candidate.current_position or ""
    _company = candidate.current_company or ""
    exp_text = (_exp + " " + _pos + " " + _company).strip()
    if exp_kws and exp_text:
        text = exp_text.lower()
        matched = [kw for kw in exp_kws if kw.lower() in text]
        if matched:
            pct = len(matched) / len(exp_kws)
            exp_score = int(pct * 40)
            score += exp_score
            match_reasons.append(f"经验匹配({exp_score}/40): {', '.join(matched)}")
            if pct < 0.5:
                missing_info.append("经验关键词匹配不足50%")
            experience_match = 1 if pct >= 0.5 else 0
        else:
            match_reasons.append("经验关键词未匹配")
            missing_info.append("经验关键词未匹配")
            experience_match = 0
    else:
        if not candidate.experience_summary:
            missing_info.append("无经验摘要")
        experience_match = 0

    # --- Capability keywords ---
    cap_raw = job.capability_keywords or ""
    cap_kws = [kw.strip() for kw in cap_raw.split(",") if kw.strip()]
    if cap_kws and candidate.skills:
        skills_text = candidate.skills.lower()
        matched = [kw for kw in cap_kws if kw.lower() in skills_text]
        if matched:
            pct = len(matched) / len(cap_kws)
            cap_score = int(pct * 30)
            score += cap_score
            match_reasons.append(f"能力匹配({cap_score}/30): {', '.join(matched)}")
            capability_match = 1 if pct >= 0.5 else 0
        else:
            match_reasons.append("能力关键词未匹配")
            missing_info.append("能力关键词未匹配")
            capability_match = 0
    else:
        if not candidate.skills:
            missing_info.append("无技能信息")
        capability_match = 0

    # --- Active status bonus ---
    active_bonus = 0
    if candidate.active_status:
        if "今日活跃" in candidate.active_status:
            active_bonus = 10
        elif "3日" in candidate.active_status or "昨日" in candidate.active_status:
            active_bonus = 7
        elif "本周" in candidate.active_status:
            active_bonus = 5
        elif "最近" in candidate.active_status:
            active_bonus = 3
        if active_bonus:
            score += active_bonus
            match_reasons.append(f"活跃度加分(+{active_bonus}): {candidate.active_status}")
    else:
        missing_info.append("活跃度未知")

    score = min(score, 100)
    return {
        "score": score,
        "match_reason": "; ".join(match_reasons),
        "missing_info": ", ".join(missing_info),
        "age_pass": age_pass,
        "experience_match": experience_match,
        "capability_match": capability_match,
    }


# --- Mode 1b: Score a scraper dict against a workbench Job ---

def _split_keywords(value: str | None) -> list[str]:
    return [k.strip().lower() for k in re.split(r"[,，、\n]+", value or "") if k.strip()]


def _extract_first_int(value: object) -> int | None:
    match = re.search(r"(\d+)", str(value or ""))
    return int(match.group(1)) if match else None


def _parse_salary_range_k(value: object) -> tuple[float, float] | None:
    """Parse common BOSS salary text into a monthly K range."""
    text = re.sub(r"\s+", "", str(value or ""))
    unit_re = r"[Kk万千]"
    number_re = r"\d+(?:\.\d+)?"

    def to_k(number: str, unit: str) -> float:
        n = float(number)
        return n * 10 if unit == "万" else n

    patterns = [
        rf"({number_re})({unit_re})[-~—－至到]({number_re})({unit_re})?",
        rf"({number_re})[-~—－至到]({number_re})({unit_re})",
        rf"({number_re})({unit_re})",
    ]
    for index, pattern in enumerate(patterns):
        match = re.search(pattern, text)
        if not match:
            continue
        if index == 0:
            low = to_k(match.group(1), match.group(2))
            high = to_k(match.group(3), match.group(4) or match.group(2))
        elif index == 1:
            low = to_k(match.group(1), match.group(3))
            high = to_k(match.group(2), match.group(3))
        else:
            low = high = to_k(match.group(1), match.group(2))
        return (min(low, high), max(low, high))
    return None


def _activity_level(candidate: dict) -> int:
    """Return recency level: 4 just now/today, 3 within 3 days, 2 this week."""
    text = " ".join([
        str(candidate.get("activeStatus") or ""),
        str(candidate.get("fullText") or ""),
    ])
    if any(token in text for token in ("刚刚活跃", "今日活跃", "今天活跃", "在线")):
        return 4
    if any(token in text for token in ("3日内", "三日内", "昨日活跃", "昨天活跃")):
        return 3
    if any(token in text for token in ("本周活跃", "近一周", "7日内", "七日内")):
        return 2
    if "最近活跃" in text:
        return 1
    return 0


def _activity_required_level(requirement: str | None) -> int:
    req = (requirement or "any").strip().lower()
    if req in ("today", "今日活跃", "today_active"):
        return 4
    if req in ("3d", "3day", "3days", "三日内", "3日内活跃"):
        return 3
    if req in ("week", "weekly", "本周活跃"):
        return 2
    return 0


def score_candidate_by_job(candidate: dict, job) -> dict:
    """Score a scraper dict (EXTRACT_CARDS_JS shape) against a Job's dimensions.

    Uses the job's current userscript-facing filters and keywords instead of
    the YAML profile.
    Returns the same shape as batch_score_candidate: {score, is_blocked, details}.
    """
    exp_kws = _split_keywords(job.experience_keywords)
    cap_kws = _split_keywords(job.capability_keywords)
    age_min = getattr(job, "age_min", 0) or 0
    age_max = job.age_max or 99
    min_experience_years = getattr(job, "min_experience_years", 0) or 0
    salary_min_k = max(0, getattr(job, "salary_min_k", 0) or 0)
    salary_max_k = getattr(job, "salary_max_k", 0) or 0
    active_required = _activity_required_level(getattr(job, "active_requirement", "any"))

    full_text = candidate.get("fullText", "")
    skills_text = " ".join(candidate.get("skills", [])).lower()
    text = " ".join([
        full_text,
        skills_text,
        candidate.get("company", ""),
        candidate.get("title", ""),
    ]).lower()

    score = 40
    details = []

    # Experience keywords (proportional, up to +35)
    # No keywords configured on the job → nothing to fail, treat as matched.
    experience_match = 1
    if exp_kws:
        hit = [kw for kw in exp_kws if kw in text]
        if hit:
            s = int(len(hit) / len(exp_kws) * 35)
            score += s
            details.append(f"经验匹配(+{s}): {', '.join(hit)}")
            experience_match = 1 if len(hit) / len(exp_kws) >= 0.5 else 0
        else:
            details.append("经验关键词未匹配")
            experience_match = 0

    # Capability keywords (proportional, up to +25)
    capability_match = 1
    if cap_kws:
        hit = [kw for kw in cap_kws if kw in skills_text or kw in text]
        if hit:
            s = int(len(hit) / len(cap_kws) * 25)
            score += s
            details.append(f"能力匹配(+{s}): {', '.join(hit)}")
            capability_match = 1 if len(hit) / len(cap_kws) >= 0.5 else 0
        else:
            details.append("能力关键词未匹配")
            capability_match = 0

    # Age: configured min/max is a hard filter when age is present.
    is_blocked = False
    age_pass = 1
    age = _extract_first_int(candidate.get("age", ""))
    if age is not None:
        if age_min and age < age_min:
            is_blocked = True
            age_pass = 0
            details.append(f"年龄低于要求: {age}<{age_min}")
        elif age <= age_max:
            score += 5
            details.append(f"年龄符合(+5): {age}岁")
        else:
            is_blocked = True
            age_pass = 0
            details.append(f"年龄超限: {age}>{age_max}")

    # Salary: configured min/max is a hard filter when salary is parseable.
    if salary_min_k or salary_max_k:
        salary_max_k = max(salary_min_k, salary_max_k or 999)
        candidate_salary = _parse_salary_range_k(candidate.get("salary", ""))
        if candidate_salary is None:
            details.append("薪资未知，暂不按薪资拦截")
        elif candidate_salary[1] < salary_min_k or candidate_salary[0] > salary_max_k:
            is_blocked = True
            details.append(
                f"薪资不匹配: {candidate.get('salary', '')}，要求{salary_min_k}-{salary_max_k}K"
            )
        else:
            score += 5
            details.append(
                f"薪资匹配(+5): {candidate.get('salary', '')}，要求{salary_min_k}-{salary_max_k}K"
            )

    # Experience years: minimum years is a hard filter when present.
    yrs = _extract_first_int(candidate.get("experience", ""))
    if yrs is not None:
        if min_experience_years and yrs < min_experience_years:
            is_blocked = True
            experience_match = 0
            details.append(f"经验年限不足: {yrs}<{min_experience_years}年")
        elif 3 <= yrs <= 8:
            score += 5
            details.append(f"经验年限(+5): {yrs}年")
        elif yrs < 2:
            score -= 5
            details.append(f"经验不足(-5): {yrs}年")

    # Education
    edu = candidate.get("education", "")
    if "博士" in edu:
        score += 6
        details.append("博士学历(+6)")
    elif "硕士" in edu:
        score += 3
        details.append("硕士学历(+3)")

    # Activity: selected recency is a hard filter; better recency still scores up.
    activity_level = _activity_level(candidate)
    if active_required and activity_level < active_required:
        is_blocked = True
        details.append("活跃度不符合要求")
    if activity_level >= 4:
        score += 8
        details.append("活跃度(+8): 刚刚/今日活跃")
    elif activity_level >= 3:
        score += 5
        details.append("活跃度(+5): 3日内活跃")
    elif activity_level >= 2:
        score += 3
        details.append("活跃度(+3): 本周活跃")

    # Availability
    status = candidate.get("jobStatus", "")
    if "离职" in status:
        score += 4
        details.append("离职可到岗(+4)")
    elif "月内" in status:
        score += 2
        details.append("月内到岗(+2)")
    if "暂不考虑" in status:
        is_blocked = True
        details.append("状态排除(暂不考虑)")

    score = max(0, min(100, score))
    return {
        "score": score,
        "is_blocked": is_blocked,
        "details": details,
        "summary": f"按「{job.title}」评分 {score}/100",
        "age_pass": age_pass,
        "experience_match": experience_match,
        "capability_match": capability_match,
    }


# --- Mode 2: Batch scoring from search results (dict-based) ---

def batch_score_candidate(candidate: dict, profile: Optional[dict] = None) -> dict:
    """Multi-dimension scoring for batch search results.

    Uses YAML profile config for weights and keywords.
    Returns {score, domain_hits, tech_hits, bonus_hits, details}.
    """
    if profile is None:
        profile = load_profile()

    scoring_cfg = profile.get("scoring", {})
    filter_cfg = profile.get("filter", {})
    domain_kw = [k.lower() for k in scoring_cfg.get("domain_keywords", [])]
    tech_kw = [k.lower() for k in scoring_cfg.get("tech_keywords", [])]
    bonus_kw = [k.lower() for k in scoring_cfg.get("bonus_keywords", [])]
    max_age = filter_cfg.get("max_age", 99)
    max_salary_k = filter_cfg.get("max_salary_k", 99)
    exclude_status = [s.lower() for s in filter_cfg.get("exclude_status", [])]

    text_parts = [
        candidate.get("fullText", ""),
        " ".join(candidate.get("skills", [])),
        candidate.get("company", ""),
        candidate.get("title", ""),
    ]
    text = " ".join(text_parts).lower()

    score = 50
    details = []

    # Domain keywords (e.g. 电商, 品牌)
    domain_hits = [kw for kw in domain_kw if kw in text]
    domain_score = min(len(domain_hits) * 8, 24)
    score += domain_score
    if domain_hits:
        details.append(f"领域匹配(+{domain_score}): {', '.join(domain_hits)}")

    # Tech keywords (e.g. 项目管理, 天猫)
    tech_hits = [kw for kw in tech_kw if kw in text]
    tech_score = min(len(tech_hits) * 6, 24)
    score += tech_score
    if tech_hits:
        details.append(f"技能匹配(+{tech_score}): {', '.join(tech_hits)}")

    # Bonus keywords (e.g. 从0到1, 团队管理)
    bonus_hits = [kw for kw in bonus_kw if kw in text]
    if bonus_hits:
        score += 10
        details.append(f"加分项(+10): {', '.join(bonus_hits)}")

    # Education bonus
    edu = candidate.get("education", "")
    if "博士" in edu:
        score += 8
        details.append("博士学历+8")
    elif "硕士" in edu:
        score += 4
        details.append("硕士学历+4")

    # Salary match
    sal_nums = re.findall(r"(\d+)", candidate.get("salary", "").replace("面议", ""))
    if sal_nums:
        sal_max = max(int(x) for x in sal_nums)
        if sal_max <= 25:
            score += 6
            details.append(f"薪资匹配(+6): ≤25K")
        elif sal_max <= 30:
            score += 3
            details.append(f"薪资匹配(+3): ≤30K")
        elif sal_max > max_salary_k:
            score -= 5
            details.append(f"薪资偏高(-5): {sal_max}K")

    # Experience years
    exp_m = re.search(r"(\d+)", candidate.get("experience", ""))
    if exp_m:
        yrs = int(exp_m.group(1))
        if 3 <= yrs <= 7:
            score += 5
            details.append(f"经验年限(+5): {yrs}年")
        elif yrs < 2:
            score -= 5
            details.append(f"经验不足(-5): {yrs}年")

    # Job status
    status = candidate.get("jobStatus", "").lower()
    if "离职" in status:
        score += 4
        details.append("离职可到岗(+4)")
    elif "月内" in status:
        score += 2
        details.append("月内到岗(+2)")

    # Age filter
    age_m = re.search(r"(\d+)", str(candidate.get("age", "")))
    if age_m:
        age = int(age_m.group(1))
        if age > max_age:
            score -= 10
            details.append(f"年龄超限(-10): {age}岁")

    # Hard block
    is_blocked = False
    if any(ex in status for ex in exclude_status):
        is_blocked = True
        details.append("状态排除(暂不考虑)")
    if age_m and int(age_m.group(1)) > max_age:
        is_blocked = True

    score = max(0, min(100, score))

    return {
        "score": score,
        "is_blocked": is_blocked,
        "domain_hits": domain_hits,
        "tech_hits": tech_hits,
        "bonus_hits": bonus_hits,
        "details": details,
        "summary": f"综合评分 {score}/100",
    }


def extract_work_years_int(work_years_str: Optional[str]) -> Optional[int]:
    if not work_years_str:
        return None
    m = re.search(r"(\d+)\s*年", work_years_str)
    return int(m.group(1)) if m else None


def extract_skills(text: str) -> list[str]:
    tokens = re.split(r"[,;，；、/|\s]+", text)
    return [t.strip() for t in tokens if t.strip()]
