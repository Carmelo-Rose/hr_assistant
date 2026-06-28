# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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

### Before running: connect Chrome

```bash
# Chrome must expose CDP on port 9222:
# Open Chrome with: --remote-debugging-port=9222
# Then connect backend to it:
curl -X POST http://localhost:8000/api/browser/start
```

Or set `BOSS_CDP_URL` in `backend/.env` to override the default port.

## Architecture

```
backend/
  app/
    main.py              # FastAPI app, lifespan seeds 4 default jobs into SQLite
    models/              # SQLAlchemy ORM: Candidate, Job, Outreach, MatchResult, PageSnapshot
    routers/             # Route handlers: browser, candidates, jobs, outreach, queue
    services/
      browser.py         # Singleton CDP browser manager (module-level _context)
      boss_scraper.py    # Playwright scraping: JS injection to parse BOSS SPA card lists
      scoring.py         # Two-mode scoring engine (see below)
      templating.py      # Outreach message template rendering
  config/
    search_profile.yaml  # Job search keywords + scoring weights (edit to customize)
  data/
    boss_hr.db           # SQLite database (auto-created)
frontend/
  src/
    App.tsx              # Router: /dashboard → Dashboard, /jobs → JobConfig
    pages/               # Dashboard (today's queue) and JobConfig (edit jobs)
    components/          # Layout and shared UI
```

### Browser singleton

`browser.py` holds a module-level `_context: BrowserContext` (not a class). `get_browser_context()` returns it synchronously; `start_browser()` tries 4 strategies in order: configured CDP URL → auto-detect ports 9222/9229/19222 → launch system Chrome → bare Chromium fallback. Call `POST /api/browser/start` before any scraping.

### Scoring engine (`scoring.py`)

Two distinct modes — don't mix them:

- **`score_candidate(candidate: Candidate, job: Job)`** — one-to-one match using ORM objects; used in the per-candidate outreach flow. Scores age (20), experience keywords (40), capability keywords (30), active status (10).
- **`batch_score_candidate(candidate: dict, profile: dict)`** — batch mode using raw dicts from scraper output; driven by `search_profile.yaml`. Starts at base 50, adds/subtracts points for domain/tech/bonus keywords, education, salary, experience years, job status.

### Scraper (`boss_scraper.py`)

Operates inside the recruiter-side SPA at `zhipin.com/web/boss/recommend`. Uses `EXTRACT_CARDS_JS` (inline JS string) injected into the search iframe to parse `li.geek-info-card` elements. `multi_search()` deduplicates across keywords by `expectId`.

### Config-driven customization

Edit `backend/config/search_profile.yaml` to change search keywords, scoring weights, age/salary filters, and excluded candidate statuses — no code changes needed.

## Tech Stack

- **Backend**: Python 3.14, FastAPI, SQLAlchemy + SQLite, Playwright (CDP), uv
- **Frontend**: React 19, TypeScript 6, Vite 5, TailwindCSS 4, TanStack Query, axios, oxlint
- **CORS**: backend allows `localhost:5173` and `localhost:3000`
