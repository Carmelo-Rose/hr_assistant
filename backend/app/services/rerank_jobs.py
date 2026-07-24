"""In-process progress tracking for userscript AI scoring jobs.

The desktop helper normally runs as one local FastAPI process.  Keeping the
short-lived task state in memory lets the userscript show actual LLM batch
progress without adding a queueing service or a database migration.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from threading import Lock
from uuid import uuid4


@dataclass
class RerankJob:
    id: str
    job_id: str
    job_title: str
    total: int
    processed: int = 0
    scored: int = 0
    status: str = "queued"
    message: str = "等待开始评分"
    error: str = ""


class RerankJobStore:
    """Small, thread-safe registry retained for the lifetime of the server."""

    def __init__(self) -> None:
        self._jobs: dict[str, RerankJob] = {}
        self._lock = Lock()

    def create(self, *, job_id: str, job_title: str, total: int) -> RerankJob:
        job = RerankJob(id=uuid4().hex, job_id=job_id, job_title=job_title, total=total)
        with self._lock:
            self._jobs[job.id] = job
            # Bound memory use while preserving recent completed-task feedback.
            if len(self._jobs) > 100:
                finished = [key for key, value in self._jobs.items() if value.status in {"succeeded", "failed"}]
                for key in finished[: len(self._jobs) - 100]:
                    self._jobs.pop(key, None)
        return job

    def get(self, task_id: str) -> dict | None:
        with self._lock:
            job = self._jobs.get(task_id)
            return asdict(job) if job else None

    def update(self, task_id: str, **changes: object) -> None:
        with self._lock:
            job = self._jobs.get(task_id)
            if not job:
                return
            for key, value in changes.items():
                setattr(job, key, value)


rerank_jobs = RerankJobStore()
