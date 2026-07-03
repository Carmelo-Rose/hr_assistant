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
        with open(PROFILE_PATH, "r") as f:
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

def score_candidate_by_job(candidate: dict, job) -> dict:
    """Score a scraper dict (EXTRACT_CARDS_JS shape) against a Job's dimensions.

    Uses the job's age_max / experience_keywords / capability_keywords (the
    fields editable on the 工作台 岗位配置 page) instead of the YAML profile.
    Returns the same shape as batch_score_candidate: {score, is_blocked, details}.
    """
    exp_kws = [k.strip().lower() for k in (job.experience_keywords or "").split(",") if k.strip()]
    cap_kws = [k.strip().lower() for k in (job.capability_keywords or "").split(",") if k.strip()]
    age_max = job.age_max or 99

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

    # Age: within → small bonus, over → hard block. No age found → can't fail it.
    is_blocked = False
    age_pass = 1
    age_m = re.search(r"(\d+)", str(candidate.get("age", "")))
    if age_m:
        age = int(age_m.group(1))
        if age <= age_max:
            score += 5
            details.append(f"年龄合格(+5): {age}≤{age_max}")
        else:
            is_blocked = True
            age_pass = 0
            details.append(f"年龄超限: {age}>{age_max}")

    # Experience years sweet spot
    exp_m = re.search(r"(\d+)", candidate.get("experience", ""))
    if exp_m:
        yrs = int(exp_m.group(1))
        if 3 <= yrs <= 8:
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

    # Activity (parsed from card text)
    if "刚刚活跃" in full_text or "今日活跃" in full_text:
        score += 8
        details.append("活跃度(+8): 刚刚/今日活跃")
    elif "本周活跃" in full_text or "3日内" in full_text or "昨日活跃" in full_text:
        score += 5
        details.append("活跃度(+5): 近期活跃")

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
