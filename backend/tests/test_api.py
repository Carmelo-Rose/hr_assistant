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