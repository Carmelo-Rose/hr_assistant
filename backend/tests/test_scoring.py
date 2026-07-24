"""Unit tests for the scoring engine."""

from app.models.job import Job
from app.models.candidate import Candidate
from app.services.scoring import score_candidate, score_candidate_by_job


def test_score_age_pass():
    job = Job(id="j1", title="测试", age_max=35)
    c = Candidate(boss_id="b1", name="张三", age=28)
    result = score_candidate(c, job)
    assert result["score"] >= 20
    assert result["age_pass"] == 1


def test_score_age_exceed():
    job = Job(id="j1", title="测试", age_max=35)
    c = Candidate(boss_id="b1", name="李四", age=40)
    result = score_candidate(c, job)
    assert "年龄40岁，超出35岁上限" in result["match_reason"]
    assert result["age_pass"] == 0


def test_score_experience_match():
    job = Job(id="j1", title="测试", experience_keywords="电商,天猫,运营")
    c = Candidate(boss_id="b1", name="王五", experience_summary="5年天猫电商运营经验，管理过品牌旗舰店", current_position="天猫运营经理")
    result = score_candidate(c, job)
    assert result["experience_match"] == 1
    assert result["score"] > 0


def test_score_experience_none():
    job = Job(id="j1", title="测试", experience_keywords="电商,天猫")
    c = Candidate(boss_id="b1", name="赵六", experience_summary="", current_position="")
    result = score_candidate(c, job)
    assert "无经验摘要" in result["missing_info"]
    assert result["experience_match"] == 0


def test_score_capability():
    job = Job(id="j1", title="测试", capability_keywords="直通车,数据运营,品类管理")
    c = Candidate(boss_id="b1", name="七七", skills="直通车推广,数据运营分析,品类管理")
    result = score_candidate(c, job)
    assert result["capability_match"] == 1
    assert result["score"] > 0


def test_score_active_bonus():
    job = Job(id="j1", title="测试")
    c = Candidate(boss_id="b1", name="八八", active_status="今日活跃")
    result = score_candidate(c, job)
    assert "活跃度加分" in result["match_reason"]

    c2 = Candidate(boss_id="b2", name="九九", active_status="")
    result2 = score_candidate(c2, job)
    assert "活跃度未知" in result2["missing_info"]


def test_score_missing_info_combined():
    job = Job(id="j1", title="测试", age_max=30, experience_keywords="电商", capability_keywords="直通车")
    c = Candidate(boss_id="b1", name="十十", age=28)
    result = score_candidate(c, job)
    # age known, experience none, skills none, active none
    assert "无经验摘要" in result["missing_info"]
    assert "无技能信息" in result["missing_info"]
    assert "活跃度未知" in result["missing_info"]


def test_score_batch_fields_recover_score():
    """A batch-stored candidate with age + experience_summary + skills should
    score on all dimensions, not collapse to capability-only.

    Locks the batch→enqueue handoff fix: previously batch candidates stored no
    age / experience_summary, so score_candidate degraded badly.
    """
    job = Job(
        id="j1", title="测试", age_max=35,
        experience_keywords="电商,天猫,运营",
        capability_keywords="直通车,数据运营",
    )
    full = Candidate(
        boss_id="b-full", name="补全",
        age=30,
        experience_summary="5年天猫电商运营，负责直通车与数据运营",
        current_position="天猫运营",
        skills="直通车,数据运营",
    )
    skills_only = Candidate(
        boss_id="b-thin", name="缺数据",
        skills="直通车,数据运营",
    )

    full_res = score_candidate(full, job)
    thin_res = score_candidate(skills_only, job)

    assert full_res["age_pass"] == 1
    assert full_res["experience_match"] == 1
    assert full_res["score"] > thin_res["score"]


def test_score_experience_position_only():
    """Defensive: experience matches via position/company even with empty summary."""
    job = Job(id="j1", title="测试", experience_keywords="天猫,运营")
    c = Candidate(boss_id="b1", name="无摘要", experience_summary="",
                  current_position="天猫运营经理")
    result = score_candidate(c, job)
    assert result["experience_match"] == 1


def test_score_clamp():
    job = Job(id="j1", title="测试", age_max=99, experience_keywords="电商,天猫,运营,推广,营销", capability_keywords="直通车,数据,品类,品牌,策划,管理")
    c = Candidate(boss_id="b1", name="满分", age=25,
                  experience_summary="多年电商天猫运营推广营销经验",
                  skills="直通车,数据分析,品类管理,品牌策划,项目管理",
                  active_status="今日活跃")
    result = score_candidate(c, job)
    assert result["score"] <= 100
    assert result["score"] >= 90


def test_userscript_score_blocks_age_min():
    job = Job(id="j1", title="测试", age_min=25, age_max=38)
    result = score_candidate_by_job({"age": "24岁", "fullText": "今日活跃"}, job)
    assert result["is_blocked"] is True
    assert result["age_pass"] == 0
    assert "年龄低于要求" in "；".join(result["details"])


def test_userscript_score_blocks_min_experience_years():
    job = Job(id="j1", title="测试", min_experience_years=3)
    result = score_candidate_by_job({"experience": "2年", "fullText": "今日活跃"}, job)
    assert result["is_blocked"] is True
    assert "经验年限不足" in "；".join(result["details"])


def test_userscript_score_blocks_activity_requirement():
    job = Job(id="j1", title="测试", active_requirement="3d")
    result = score_candidate_by_job({"fullText": "本周活跃"}, job)
    assert result["is_blocked"] is True
    assert "活跃度不符合要求" in "；".join(result["details"])

    fresh = score_candidate_by_job({"activeStatus": "今日活跃"}, job)
    assert fresh["is_blocked"] is False


def test_userscript_score_splits_chinese_keyword_separators():
    job = Job(
        id="j1",
        title="测试",
        experience_keywords="天猫，抖音、电商运营",
        capability_keywords="团队管理，渠道策略、项目管理",
    )
    result = score_candidate_by_job(
        {
            "fullText": "5年天猫电商运营，负责团队管理和项目管理，今日活跃",
            "skills": ["渠道策略"],
        },
        job,
    )
    assert result["experience_match"] == 1
    assert result["capability_match"] == 1
def test_userscript_score_salary_range_overlap_passes():
    job = Job(id="j1", title="salary", salary_min_k=20, salary_max_k=30)
    result = score_candidate_by_job({"salary": "25-35K"}, job)
    assert result["is_blocked"] is False
    assert any("薪资匹配" in detail for detail in result["details"])


def test_userscript_score_salary_range_outside_blocks():
    job = Job(id="j1", title="salary", salary_min_k=20, salary_max_k=30)
    result = score_candidate_by_job({"salary": "10-15K"}, job)
    assert result["is_blocked"] is True
    assert any("薪资不匹配" in detail for detail in result["details"])


def test_userscript_score_salary_unknown_is_not_blocked():
    job = Job(id="j1", title="salary", salary_min_k=20, salary_max_k=30)
    result = score_candidate_by_job({"salary": "面议"}, job)
    assert result["is_blocked"] is False
