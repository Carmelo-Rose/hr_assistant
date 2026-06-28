# BOSS 企业招聘触达助手

本地工作台：`FastAPI + SQLite + React/Vite`。

## 新增特性

- **CDP 浏览器连接** — 不再新开 Playwright 浏览器，直接连接你已登录的 Chrome（`--remote-debugging-port=9222`），大幅降低风控检测
- **多关键词批量搜索** — 在 BOSS 招聘者后台按关键词批量采集候选人，自动去重
- **多维评分引擎** — 年龄/经验/技能/薪资/学历/到岗状态，支持 YAML 配置权重
- **批量评分** — 对已入库候选人重新评分

## 快速开始

### 1. 启动后端

```bash
cd backend
uv sync
uv run playwright install chromium
uv run uvicorn app.main:app --reload --port 8000
```

### 2. 启动前端

```bash
cd frontend
npm install
npm run dev
```

打开 http://localhost:5173

### 3. 配置搜索

编辑 `backend/config/search_profile.yaml`，填入你的岗位关键词和评分规则。

### 4. 连接浏览器

确保 Chrome 已打开 `--remote-debugging-port=9222`，然后：

```bash
# 或者让系统自动启动
curl -X POST http://localhost:8000/api/browser/start
```

## API

| Method | Endpoint | 说明 |
|--------|----------|------|
| POST | /api/browser/start | 连接/启动 Chrome |
| GET | /api/browser/status | 浏览器状态 |
| POST | /api/candidates/capture-current | 采集当前 BOSS 页面候选人 |
| POST | /api/candidates/batch-search | **多关键词批量搜索候选人** |
| POST | /api/candidates/batch-score | **对候选人群批量评分** |
| GET | /api/queue/today | 今日触达队列 |
| POST | /api/outreach/{id}/draft | 生成话术 |
| POST | /api/outreach/{id}/fill | 填入 BOSS 输入框 |
| PATCH | /api/outreach/{id}/status | 标记已发/跳过 |
| GET | /api/jobs | 岗位列表 |
| PATCH | /api/jobs/{id} | 编辑岗位 |

## 浏览器策略

本项目优先通过 CDP（Chrome DevTools Protocol）连接你**已在使用的 Chrome**，而非新开自动化浏览器。这使 BOSS 检测到的浏览器特征与你日常使用完全一致。

连接策略（自动降级）：
1. 环境变量 `BOSS_CDP_URL` 指定的端口
2. 自动检测 `9222/9229/19222` 端口
3. 启动系统 Chrome + 独立 profile
4. 回退到 Playwright 裸 Chromium
