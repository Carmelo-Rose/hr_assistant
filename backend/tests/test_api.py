"""API integration tests for all endpoints except browser-dependent ones."""

from fastapi.testclient import TestClient


def test_list_jobs(client: TestClient):
    resp = client.get("/api/jobs")
    assert resp.status_code == 200
    jobs = resp.json()
    assert len(jobs) == 4
    ids = {j["id"] for j in jobs}
    assert ids == {"job-ec-pm", "job-tmall-ops", "job-pdd-ops", "job-network"}


def test_patch_job(client: TestClient):
    resp = client.patch("/api/jobs/job-ec-pm", json={"age_max": 40, "template": "新{name}模板"})
    assert resp.status_code == 200
    assert resp.json()["age_max"] == 40
    assert resp.json()["template"] == "新{name}模板"


def test_patch_job_not_found(client: TestClient):
    resp = client.patch("/api/jobs/nonexist", json={"age_max": 30})
    assert resp.status_code == 404
    assert "not found" in resp.json()["detail"].lower()


def test_create_job(client: TestClient):
    resp = client.post(
        "/api/jobs",
        json={
            "title": "新增测试岗位",
            "age_min": 24,
            "age_max": 38,
            "min_experience_years": 3,
            "experience_keywords": "天猫，抖音",
            "capability_keywords": "团队管理、项目管理",
            "active_requirement": "3d",
        },
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["id"].startswith("job-custom-")
    assert data["title"] == "新增测试岗位"
    assert data["age_min"] == 24
    assert data["age_max"] == 38
    assert data["min_experience_years"] == 3
    assert data["active_requirement"] == "3d"

    jobs = client.get("/api/jobs").json()
    assert any(j["id"] == data["id"] for j in jobs)


def test_create_job_requires_title(client: TestClient):
    resp = client.post("/api/jobs", json={"title": " "})
    assert resp.status_code == 400
    assert "title" in resp.json()["detail"].lower()


def test_ext_jobs_support_full_create_and_patch(client: TestClient):
    resp = client.get("/api/ext/jobs")
    assert resp.status_code == 200
    first = resp.json()[0]
    assert {
        "id",
        "title",
        "department",
        "age_min",
        "age_max",
        "salary_min_k",
        "salary_max_k",
        "min_experience_years",
        "experience_keywords",
        "capability_keywords",
        "active_requirement",
        "turnover_frequency",
        "active_hours",
        "template",
    }.issubset(first.keys())

    payload = {
        "title": "custom ext job",
        "age_min": 25,
        "age_max": 39,
        "salary_min_k": 20,
        "salary_max_k": 35,
        "min_experience_years": 4,
        "experience_keywords": "tmall,douyin",
        "capability_keywords": "team,project",
        "active_requirement": "3d",
        "turnover_frequency": "fewer_than_3_in_5y",
    }
    created = client.post("/api/ext/jobs", json=payload)
    assert created.status_code == 200
    created_data = created.json()
    assert created_data["id"].startswith("job-custom-")
    for key, value in payload.items():
        assert created_data[key] == value

    patch = {
        "age_min": 26,
        "age_max": 40,
        "salary_min_k": 22,
        "salary_max_k": 38,
        "min_experience_years": 5,
        "experience_keywords": "tmall",
        "capability_keywords": "project",
        "active_requirement": "week",
        "turnover_frequency": "average_job_over_1y",
    }
    updated = client.patch(f"/api/ext/jobs/{created_data['id']}", json=patch)
    assert updated.status_code == 200
    updated_data = updated.json()
    for key, value in patch.items():
        assert updated_data[key] == value


def test_ext_score_persists_candidate_share_url(client: TestClient):
    from app.models.database import SessionLocal
    from app.models.candidate import Candidate

    candidate_url = "https://www.zhipin.com/web/geek/detail/example"
    resp = client.post(
        "/api/ext/score",
        json={
            "job_id": "job-tmall-ops",
            "threshold": 0,
            "candidates": [{
                "expectId": "share-url-candidate",
                "name": "链接候选人",
                "age": "28岁",
                "experience": "5年",
                "education": "本科",
                "shareUrl": candidate_url,
                "fullText": "5年天猫运营经验",
            }],
        },
    )
    assert resp.status_code == 200

    db = SessionLocal()
    candidate = db.query(Candidate).filter(Candidate.boss_id == "share-url-candidate").one()
    assert candidate.share_url == candidate_url
    db.close()


def test_create_draft(client: TestClient):
    """Create candidate + match result, then draft."""
    from app.models.database import SessionLocal
    from app.models.candidate import Candidate
    from app.models.match_result import MatchResult

    db = SessionLocal()
    c = Candidate(boss_id="test-boss-001", name="测试候选人", work_years="3年", skills="项目管理",
                  current_position="项目经理", experience_summary="3年项目管理经验")
    db.add(c)
    db.commit()
    db.refresh(c)
    mr = MatchResult(candidate_id=c.id, job_id="job-ec-pm", score=75, status="new")
    db.add(mr)
    db.commit()
    db.refresh(mr)
    db.close()

    resp = client.post(f"/api/outreach/{mr.id}/draft")
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "drafted"
    # job-ec-pm 的招呼语为固定文案（无占位符），草稿应原样渲染该模板
    assert "从0到1" in data["draft_text"]
    assert "全平台总负责人" in data["draft_text"]


def test_draft_not_found(client: TestClient):
    resp = client.post("/api/outreach/999999/draft")
    assert resp.status_code == 404


def test_queue_empty_by_default(client: TestClient):
    resp = client.get("/api/queue/today")
    assert resp.status_code == 200
    assert resp.json() == []


def test_queue_with_candidate(client: TestClient):
    """Insert candidate + match, verify queue shows it."""
    from app.models.database import SessionLocal
    from app.models.candidate import Candidate
    from app.models.match_result import MatchResult

    db = SessionLocal()
    c = Candidate(boss_id="test-queue-1", name="队列候选人", work_years="5年",
                  skills="天猫运营,直通车", experience_summary="5年天猫运营经验",
                  active_status="今日活跃")
    db.add(c)
    db.commit()
    db.refresh(c)
    mr = MatchResult(candidate_id=c.id, job_id="job-tmall-ops",
                     score=85, age_pass=1, experience_match=1, capability_match=1,
                     match_reason="高分匹配", status="new")
    db.add(mr)
    db.commit()
    db.close()

    resp = client.get("/api/queue/today")
    assert resp.status_code == 200
    items = resp.json()
    assert len(items) >= 1
    assert any(it["name"] == "队列候选人" for it in items)


def test_queue_includes_boss_id_and_profile_fields(client: TestClient):
    from app.models.database import SessionLocal
    from app.models.candidate import Candidate
    from app.models.match_result import MatchResult

    db = SessionLocal()
    c = Candidate(
        boss_id="queue-boss-1",
        expect_id="queue-boss-1",
        name="queue-candidate",
        age=29,
        education="本科",
        work_years="6年",
        salary_range="25-35K",
        job_status="在职-月内到岗",
        expected_city="广州",
        skills="天猫运营,数据分析",
        current_company="示例公司",
        current_position="电商负责人",
        school="示例大学",
        major="电子商务",
        experience_summary="负责天猫店铺从零到一运营",
        raw_snapshot="候选人卡片原始快照",
        source_keyword="天猫运营",
        share_url="https://www.zhipin.com/example-candidate",
    )
    db.add(c)
    db.commit()
    db.refresh(c)
    mr = MatchResult(candidate_id=c.id, job_id="job-ec-pm", score=88, status="new")
    db.add(mr)
    db.commit()
    db.close()

    resp = client.get("/api/queue/today")
    assert resp.status_code == 200
    item = next(it for it in resp.json() if it["name"] == "queue-candidate")
    assert item["boss_id"] == "queue-boss-1"
    assert item["age"] == 29
    assert item["education"] == "本科"
    assert item["work_years"] == "6年"
    assert item["expected_city"] == "广州"
    assert item["skills"] == "天猫运营,数据分析"
    assert item["company"] == "示例公司"
    assert item["title"] == "电商负责人"
    assert item["school"] == "示例大学"
    assert item["major"] == "电子商务"
    assert item["experience_summary"] == "负责天猫店铺从零到一运营"
    assert item["raw_snapshot"] == "候选人卡片原始快照"
    assert item["source_keyword"] == "天猫运营"
    assert item["share_url"] == "https://www.zhipin.com/example-candidate"
    assert item["created_at"]
    assert item["updated_at"]


def test_queue_keeps_same_candidate_once_per_job(client: TestClient):
    """The all-jobs queue must not merge a candidate's different job matches."""
    from app.models.database import SessionLocal
    from app.models.candidate import Candidate
    from app.models.match_result import MatchResult

    db = SessionLocal()
    c = Candidate(boss_id="queue-multi-job-1", name="multi-job-candidate")
    db.add(c)
    db.commit()
    db.refresh(c)
    db.add_all([
        MatchResult(candidate_id=c.id, job_id="job-ec-pm", score=70, status="new"),
        MatchResult(candidate_id=c.id, job_id="job-network", score=90, status="new"),
    ])
    db.commit()
    db.close()

    resp = client.get("/api/queue/today")
    assert resp.status_code == 200
    items = [it for it in resp.json() if it["name"] == "multi-job-candidate"]
    assert {it["job_id"] for it in items} == {"job-ec-pm", "job-network"}
    assert all(it["job_title"] for it in items)


def test_open_candidate_relay_round_trip(client: TestClient):
    resp = client.post("/api/ext/open-candidate", json={"boss_id": "boss-123", "name": "candidate"})
    assert resp.status_code == 200
    assert resp.json()["ok"] is True

    pending = client.get("/api/ext/pending-open")
    assert pending.status_code == 200
    assert pending.json() == {"boss_id": "boss-123", "name": "candidate"}

    consumed = client.get("/api/ext/pending-open")
    assert consumed.status_code == 200
    assert consumed.json() == {"boss_id": ""}


def test_queue_filter_by_job(client: TestClient):
    resp = client.get("/api/queue/today", params={"job_id": "job-network"})
    assert resp.status_code == 200


def test_update_outreach_status(client: TestClient):
    from app.models.database import SessionLocal
    from app.models.candidate import Candidate
    from app.models.match_result import MatchResult

    db = SessionLocal()
    c = Candidate(boss_id="test-status-1", name="状态测试")
    db.add(c)
    db.commit()
    db.refresh(c)
    mr = MatchResult(candidate_id=c.id, job_id="job-ec-pm", score=60, status="drafted")
    db.add(mr)
    db.commit()
    db.refresh(mr)
    db.close()

    # Mark as sent
    resp = client.patch(f"/api/outreach/{mr.id}/status", json={"status": "sent_manual"})
    assert resp.status_code == 200
    assert resp.json()["status"] == "sent_manual"

    # Mark as skipped - use a fresh candidate/job
    db2 = SessionLocal()
    c2_id = db2.query(Candidate).filter(Candidate.boss_id == "test-status-2").first()
    if not c2_id:
        c2 = Candidate(boss_id="test-status-2", name="跳过测试")
        db2.add(c2)
        db2.commit()
        db2.refresh(c2)
        c2_id = c2.id
    mr2 = MatchResult(candidate_id=c2_id, job_id="job-pdd-ops", score=50, status="drafted")
    db2.add(mr2)
    db2.commit()
    db2.refresh(mr2)
    db2.close()

    resp = client.patch(f"/api/outreach/{mr2.id}/status", json={"status": "skipped"})
    assert resp.status_code == 200
    assert resp.json()["status"] == "skipped"


def test_enqueue_batch_candidate_scores_on_all_dims(client: TestClient):
    """Batch-style candidate (age + experience_summary populated) enqueues into a
    MatchResult whose score reflects age + experience, not just capability."""
    from app.models.database import SessionLocal
    from app.models.candidate import Candidate

    db = SessionLocal()
    c = Candidate(
        boss_id="enq-1", expect_id="enq-1", name="入队测试",
        age=30,
        experience_summary="5年天猫电商运营经验，负责品牌旗舰店",
        current_position="天猫运营经理",
        work_years="5年",
        skills="天猫运营,直通车,数据运营,品类管理",
    )
    db.add(c)
    db.commit()
    db.close()

    resp = client.post("/api/candidates/enqueue",
                       json={"expect_id": "enq-1", "job_id": "job-tmall-ops"})
    assert resp.status_code == 200
    data = resp.json()
    assert data["created"] is True
    assert data["status"] == "queued"

    # Verify the created MatchResult scored on age + experience, not capability-only
    from app.models.match_result import MatchResult
    db2 = SessionLocal()
    mr = db2.query(MatchResult).filter(MatchResult.id == data["match_id"]).first()
    assert mr.age_pass == 1
    assert mr.experience_match == 1
    assert mr.score > 30  # capability-only ceiling was 30
    db2.close()

    # Enqueue again → idempotent, no new row
    resp2 = client.post("/api/candidates/enqueue",
                        json={"expect_id": "enq-1", "job_id": "job-tmall-ops"})
    assert resp2.status_code == 200
    assert resp2.json()["created"] is False
    assert resp2.json()["match_id"] == data["match_id"]


def test_update_invalid_status(client: TestClient):
    from app.models.database import SessionLocal
    from app.models.match_result import MatchResult
    from app.models.candidate import Candidate

    db = SessionLocal()
    c = Candidate(boss_id="test-invalid-1", name="无效测试")
    db.add(c)
    db.commit()
    db.refresh(c)
    mr = MatchResult(candidate_id=c.id, job_id="job-ec-pm", score=50, status="new")
    db.add(mr)
    db.commit()
    db.refresh(mr)
    db.close()

    resp = client.patch(f"/api/outreach/{mr.id}/status", json={"status": "invalid"})
    assert resp.status_code == 400


def test_llm_rerank_job_reports_real_batch_progress(client: TestClient, monkeypatch):
    """The userscript can poll durable per-batch progress instead of animating."""
    import time

    from app.models.database import SessionLocal
    from app.models.candidate import Candidate
    from app.models.match_result import MatchResult
    from app.routers import ext

    db = SessionLocal()
    candidates = [Candidate(boss_id=f"rerank-progress-{i}", name=f"评分候选人{i}") for i in range(3)]
    db.add_all(candidates)
    db.commit()
    for candidate in candidates:
        db.add(MatchResult(candidate_id=candidate.id, job_id="job-network", score=80, status="new"))
    db.commit()
    db.close()

    monkeypatch.setattr(ext.llm_scoring, "is_configured", lambda: True)
    monkeypatch.setattr(ext.llm_scoring, "build_job_desc", lambda job: job.title)
    monkeypatch.setattr(ext.llm_scoring, "_cfg", lambda: {"batch": 2})
    monkeypatch.setattr(
        ext.llm_scoring,
        "score_batch",
        lambda briefs, _job_desc: {brief["id"]: {"score": 91, "reason": "匹配"} for brief in briefs},
    )

    started = client.post("/api/ext/llm-rerank-jobs", json={"job_id": "job-network", "limit": 3})
    assert started.status_code == 202
    payload = started.json()
    assert payload["total"] == 3

    latest = None
    for _ in range(30):
        latest = client.get(f"/api/ext/llm-rerank-jobs/{payload['task_id']}").json()
        if latest["status"] in {"succeeded", "failed"}:
            break
        time.sleep(0.05)

    assert latest is not None
    assert latest["status"] == "succeeded"
    assert latest["processed"] == 3
    assert latest["scored"] == 3


def test_llm_rerank_job_skips_existing_scores(client: TestClient, monkeypatch):
    """Starting AI scoring again must preserve and skip durable prior scores."""
    import time

    from app.models.database import SessionLocal
    from app.models.candidate import Candidate
    from app.models.match_result import MatchResult
    from app.routers import ext

    db = SessionLocal()
    done = Candidate(boss_id="rerank-already-done", name="已评候选人")
    pending = Candidate(boss_id="rerank-pending", name="待评候选人")
    db.add_all([done, pending])
    db.commit()
    db.add_all([
        MatchResult(
            candidate_id=done.id,
            job_id="job-network",
            score=85,
            status="new",
            llm_score=88,
            llm_reason="原有评分",
        ),
        MatchResult(candidate_id=pending.id, job_id="job-network", score=80, status="new"),
    ])
    db.commit()
    done_id = done.id
    pending_id = pending.id
    db.close()

    monkeypatch.setattr(ext.llm_scoring, "is_configured", lambda: True)
    monkeypatch.setattr(ext.llm_scoring, "build_job_desc", lambda job: job.title)
    monkeypatch.setattr(
        ext.llm_scoring,
        "score_batch",
        lambda briefs, _job_desc: {brief["id"]: {"score": 93, "reason": "新评分"} for brief in briefs},
    )

    started = client.post("/api/ext/llm-rerank-jobs", json={"job_id": "job-network", "limit": 60})
    assert started.status_code == 202
    payload = started.json()
    assert payload["total"] == 1
    assert payload["skipped_existing"] == 1

    latest = None
    for _ in range(30):
        latest = client.get(f"/api/ext/llm-rerank-jobs/{payload['task_id']}").json()
        if latest["status"] in {"succeeded", "failed"}:
            break
        time.sleep(0.05)
    assert latest and latest["status"] == "succeeded"

    verify = SessionLocal()
    done_match = verify.query(MatchResult).filter(MatchResult.candidate_id == done_id).one()
    pending_match = verify.query(MatchResult).filter(MatchResult.candidate_id == pending_id).one()
    assert done_match.llm_score == 88
    assert done_match.llm_reason == "原有评分"
    assert pending_match.llm_score == 93
    assert pending_match.llm_reason == "新评分"
    verify.close()


def test_llm_rerank_job_returns_noop_when_everyone_is_scored(client: TestClient, monkeypatch):
    from app.models.database import SessionLocal
    from app.models.candidate import Candidate
    from app.models.match_result import MatchResult
    from app.routers import ext

    db = SessionLocal()
    candidate = Candidate(boss_id="rerank-all-done", name="全部已评")
    db.add(candidate)
    db.commit()
    db.add(MatchResult(
        candidate_id=candidate.id,
        job_id="job-network",
        score=80,
        status="new",
        llm_score=90,
        llm_reason="已有结果",
    ))
    db.commit()
    db.close()

    monkeypatch.setattr(ext.llm_scoring, "is_configured", lambda: True)
    response = client.post("/api/ext/llm-rerank-jobs", json={"job_id": "job-network"})
    assert response.status_code == 202
    payload = response.json()
    assert payload["completed"] is True
    assert payload["total"] == 0
    assert payload["skipped_existing"] == 1
    assert "无需重复评分" in payload["message"]
    assert "task_id" not in payload
