"""Unit tests for the templating engine."""

from app.models.job import Job
from app.models.candidate import Candidate
from app.services.templating import render_draft


def test_basic_variable_substitution():
    job = Job(
        id="j1", title="电商品牌项目经理",
        template="您好{name}，看到您有{experience_years}年的{key_skill}经验，与我们在招的{job_title}岗位非常匹配，方便进一步沟通吗？",
        capability_keywords="项目管理,品牌策划",
    )
    c = Candidate(
        boss_id="b1", name="张三",
        work_years="5年",
        skills="项目管理,跨部门协调",
        current_position="品牌项目经理",
    )
    result = render_draft(c, job)
    assert "张三" in result
    assert "5" in result or "多年" in result
    assert "项目管理" in result  # key_skill
    assert "电商品牌项目经理" in result


def test_missing_name():
    job = Job(id="j1", title="测试", template="您好{name}，方便聊聊吗？")
    c = Candidate(boss_id="b1", name="")
    result = render_draft(c, job)
    assert "候选人" in result


def test_experience_years_fallback():
    job = Job(id="j1", title="测试", template="您有{experience_years}年经验")
    c = Candidate(boss_id="b1", name="李四", work_years="未知")
    result = render_draft(c, job)
    assert "多年" in result


def test_key_skill_fallback_to_position():
    job = Job(id="j1", title="测试", template="您的{key_skill}很符合我们需求", capability_keywords="稀有技能")
    c = Candidate(boss_id="b1", name="王五", skills="普通技能", current_position="运营专员")
    result = render_draft(c, job)
    # key_skill should fallback to current_position since "稀有技能" not in skills
    assert "运营专员" in result


def test_all_fields():
    job = Job(
        id="j1", title="测试岗位", department="测试部",
        template="[{department}] {name} - {current_company}/{current_position} ({education}), {experience_years}年",
    )
    c = Candidate(
        boss_id="b1", name="赵六", work_years="8年",
        current_company="好公司", current_position="高级经理",
        education="本科",
    )
    result = render_draft(c, job)
    assert "测试部" in result
    assert "赵六" in result
    assert "好公司" in result
    assert "高级经理" in result
    assert "本科" in result
    assert "8" in result