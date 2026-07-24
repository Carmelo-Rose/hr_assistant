# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Project Overview

BOSS 直聘企业招聘触达助手 — a local HR recruiting workbench that connects to BOSS Zhipin via CDP (Chrome DevTools Protocol) to batch-search and score candidates, then generate personalized outreach messages.

Roadmap: incrementally integrating the open-source `boss-zhipin-mcp` module.

## Commands

### Backend (Python / FastAPI)

```bash
# Install dependencies
cd backend && uv sync

# Install Playwright browser (first time only)
cd backend && uv run playwright install chromium

# Run dev server
cd backend && uv run uvicorn app.main:app --reload --port 8000

# Run all tests
cd backend && uv run pytest

# Run a single test file
cd backend && uv run pytest tests/test_scoring.py -v
```

### Frontend (React / Vite)

```bash
# Install dependencies
cd frontend && npm install

# Dev server (http://localhost:5173)
cd frontend && npm run dev

# Type-check + build
cd frontend && npm run build

# Lint (oxlint)
cd frontend && npm run lint
```

### Daily usage (userscript flow — primary)

The reliable path is a **Tampermonkey userscript** (`userscript/boss-helper.user.js`)
running inside your own logged-in Chrome. BOSS anti-bot trusts a real browser, and
the script can click the real 打招呼 button. **No Playwright/CDP needed.**

1. **Start the backend** (it also serves the dashboard *and* the userscript):
   - macOS: double-click `start.command`
   - Windows: double-click `start.bat`
   - or manually: `cd backend && uv run uvicorn app.main:app --port 8000`
   - This opens `http://localhost:8000` — the workbench / 复盘台.
2. **One-time install** (the `/onboarding` "安装指引" page walks through it):
   - Install Tampermonkey from the Chrome Web Store.
   - Open `http://localhost:8000/boss-helper.user.js` → Tampermonkey one-click install.
     The script's `@updateURL`/`@downloadURL` point back here, so future edits
     auto-update — no more pasting the whole file.
3. **Work**: log into your BOSS recruiter account, open the talent search/recommend
   page. The "BOSS 招聘助手" panel appears on the right: pick a 岗位 → 扫描列表 →
   半自动/自动打招呼. Already-greeted candidates are greyed out and auto-skipped.

Build the dashboard once so the backend can serve it: `cd frontend && npm run build`
(produces `frontend/dist`). After that `npm run dev` is not needed for daily use.

The userscript talks to the backend under `/api/ext/*` (see `routers/ext.py`):
`/score` (per-job scoring + already-contacted flag), `/jobs` (job picker),
`/llm-draft` (personalized greeting), `/llm-rerank` (AI 精评), `/log-greeting`.

#### Legacy: Playwright/CDP path (deprecated)

`browser.py` + `boss_scraper.py` attach to a manually-launched debug Chrome via
CDP. BOSS bounces Playwright-launched pages to `about:blank`, so this is **no
longer the main flow** — the userscript replaced it. The `/api/browser/*` and
`/outreach/{id}/fill` endpoints remain only for that legacy path; the dashboard no
longer exposes the "填入输入框" button that depended on it.

## Architecture

```
start.command / start.bat   # One-click launcher: start backend + open localhost:8000
userscript/
  boss-helper.user.js   # Tampermonkey script: scan/score/greet inside real Chrome (primary data path)
backend/
  app/
    main.py              # FastAPI app; serves /boss-helper.user.js + built frontend; lifespan seeds jobs + sqlite migration
    models/              # SQLAlchemy ORM: Candidate, Job, Outreach, MatchResult (+llm_score/llm_reason), PageSnapshot
    routers/             # browser(legacy), candidates(legacy), jobs, outreach(legacy fill), queue, config, ext(userscript API)
    services/
      ingest.py          # upsert_candidate: shared Candidate upsert from scraper dict (userscript + legacy)
      scoring.py         # Rule-based scoring: score_candidate / score_candidate_by_job / batch_score_candidate
      llm_scoring.py     # 国产 OpenAI-compatible LLM: score_candidates (AI 精评) + draft_greeting (个性化话术)
      templating.py      # Static template fallback for outreach drafts (render_draft)
      browser.py         # LEGACY Playwright/CDP manager
      boss_scraper.py    # LEGACY Playwright scraping
  config/
    search_profile.yaml  # Default/global keywords + scoring weights (per-job dims live on the Job row)
  data/
    boss_hr.db           # SQLite database (auto-created + auto-migrated)
frontend/
  src/
    App.tsx              # Router: /dashboard, /jobs, /onboarding
    pages/               # Dashboard (queue/复盘 + AI精评), JobConfig (edit jobs), Onboarding (install guide)
    components/          # Layout and shared UI
```

### Userscript ↔ backend (primary flow)

`userscript/boss-helper.user.js` (Tampermonkey, served from
`http://localhost:8000/boss-helper.user.js`) runs in the recruiter's real Chrome on
`zhipin.com`. It scans `li.geek-info-card` cards, POSTs them to `/api/ext/score`
(scored against the selected workbench Job via `score_candidate_by_job`; returns
`already_contacted` so contacted people are greyed/skipped), badges each card, and
in semi-/auto mode fetches a personalized greeting from `/api/ext/llm-draft` before
filling the chat box. Sent greetings are logged via `/api/ext/log-greeting`.

### Browser singleton

`browser.py` holds a module-level `_context: BrowserContext` (not a class). `get_browser_context()` returns it synchronously. `start_browser()` default path is `_connect_via_cdp()` — attach to a manually-launched Chrome (configured `BOSS_CDP_URL` → auto-detect ports 9222/9229/19222), which BOSS anti-bot trusts. If CDP is unreachable it falls back to `_launch_persistent_chromium()` (bundled Chromium, persistent profile at `data/pw_profile`) and returns a warning steering the user back to CDP, because automation-launched browsers get bounced to about:blank by BOSS. `BOSS_FORCE_BUNDLED=1` skips CDP. Call `POST /api/browser/start` before any scraping.

### Scoring engine (`scoring.py`)

Rule-based modes — don't mix them:

- **`score_candidate_by_job(candidate: dict, job: Job)`** — **the userscript path** (`/api/ext/score`). Scores a scraper dict against the selected workbench Job's `experience_keywords` / `capability_keywords` / `age_max`. Per-job, no YAML needed.
- **`batch_score_candidate(candidate: dict, profile: dict)`** — YAML-driven fallback (`search_profile.yaml` domain/tech/bonus keywords). Used only when no Job exists.
- **`score_candidate(candidate: Candidate, job: Job)`** — legacy one-to-one ORM match for the deprecated outreach flow.

**AI 精评 (LLM rerank, optional):** `llm_scoring.py` calls a 国产 OpenAI-compatible
model (DeepSeek/Qwen/GLM/Kimi via `LLM_*` env in `backend/.env`) to re-score the
shortlist (`/api/ext/llm-rerank`, "AI 精评" button) into `MatchResult.llm_score/llm_reason`;
the queue orders by `coalesce(llm_score, score)`. The same client powers
`draft_greeting` (personalized outreach via `/api/ext/llm-draft`), which falls back
to the static `render_draft` template when `LLM_*` is unset.

### Scraper (`boss_scraper.py`)

Operates inside the recruiter-side SPA at `zhipin.com/web/boss/recommend`. Uses `EXTRACT_CARDS_JS` (inline JS string) injected into the search iframe to parse `li.geek-info-card` elements. `multi_search()` deduplicates across keywords by `expectId`.

### Config-driven customization

Edit `backend/config/search_profile.yaml` to change search keywords, scoring weights, age/salary filters, and excluded candidate statuses — no code changes needed.

## Tech Stack

- **Backend**: Python 3.14, FastAPI, SQLAlchemy + SQLite, Playwright (CDP), uv
- **Frontend**: React 19, TypeScript 6, Vite 5, TailwindCSS 4, TanStack Query, axios, oxlint
- **CORS**: backend allows `localhost:5173` and `localhost:3000`

## Userscript synchronization rule

- 修改 userscript 时，以 `userscript/boss-helper.user.js` 为主文件。
- 完成修改后，必须将相同的代码变更同步到 `userscript/生产环境使用.js`。
- 同步到生产环境脚本时，必须保留其现有生产后端地址（当前为 `http://192.168.1.198:8010`），不得改成占位符或本地地址。
