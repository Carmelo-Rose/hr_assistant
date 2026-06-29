"""把 DEFAULT_JOBS 同步进现有数据库（已 seed 过的库不会被 main.py 再次 seed）。

用法（在 backend/ 下）:
    ../.venv/bin/python -m scripts.sync_jobs
    # 或: uv run python -m scripts.sync_jobs  （需 pyproject 含运行时依赖）

存在则更新字段，不存在则插入。幂等。
"""

from app.models.database import SessionLocal, engine, Base
from app.models.job import Job
from app.seed_data import DEFAULT_JOBS


def main():
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    try:
        for d in DEFAULT_JOBS:
            job = db.query(Job).filter(Job.id == d["id"]).first()
            if job:
                for k, v in d.items():
                    setattr(job, k, v)
                action = "更新"
            else:
                db.add(Job(**d))
                action = "新增"
            print(f"  [{action}] {d['id']} — {d['title']} (age_max={d['age_max']})")
        db.commit()
        print(f"完成，共 {len(DEFAULT_JOBS)} 个岗位已同步。")
    finally:
        db.close()


if __name__ == "__main__":
    main()
