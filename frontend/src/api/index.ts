import axios from 'axios';

const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL || '/api',
  timeout: 15000,
});

export interface QueueItem {
  match_id: number;
  candidate_id: number;
  job_id: string;
  job_title: string;
  name: string;
  score: number;
  match_reason: string;
  missing_info: string;
  age_pass: number;
  experience_match: number;
  capability_match: number;
  active_status: string;
  status: string;
  outreach_id: number | null;
  llm_score: number | null;
  llm_reason: string;
  boss_id: string;
  age: number | null;
  education: string;
  work_years: string;
  salary_range: string;
  job_status: string;
  expected_city: string;
  skills: string;
  company: string;
  title: string;
  school: string;
  major: string;
  experience_summary: string;
  raw_snapshot: string;
  source_keyword: string;
  share_url: string;
  created_at: string | null;
  updated_at: string | null;
}

export interface Job {
  id: string;
  title: string;
  department: string;
  age_min: number;
  age_max: number;
  salary_min_k: number;
  salary_max_k: number;
  min_experience_years: number;
  experience_keywords: string;
  capability_keywords: string;
  active_requirement: string;
  turnover_frequency: string;
  active_hours: string;
  template: string;
}

export interface CaptureResult {
  candidate_id: number;
  name: string;
  match_count: number;
  matches: Array<{
    job_id: string;
    job_title: string;
    score: number;
    match_reason: string;
    missing_info: string;
  }>;
}

export interface DraftResult {
  outreach_id: number;
  match_id: number;
  draft_text: string;
  status: string;
}

export interface BrowserStatus {
  running: boolean;
  page_count: number;
  message: string;
}

export interface BatchCandidate {
  expectId: string;
  name: string;
  score: number;
  details: string[];
  age: string;
  education: string;
  salary: string;
  experience: string;
  company: string;
  title: string;
  jobStatus: string;
  skills: string[];
  fullText: string;
}

export interface BatchSearchResult {
  total_fetched: number;
  new_candidates: number;
  total_in_db: number;
  top_candidates: BatchCandidate[];
}

// Jobs
export const listJobs = () => api.get<Job[]>('/jobs').then(r => r.data);
export const patchJob = (id: string, data: Partial<Job>) => api.patch<Job>(`/jobs/${id}`, data).then(r => r.data);

// Queue
export const getQueue = (jobId?: string, statusFilter?: string) => {
  const params: Record<string, string> = {};
  if (jobId) params.job_id = jobId;
  if (statusFilter) params.status_filter = statusFilter;
  return api.get<QueueItem[]>('/queue/today', { params }).then(r => r.data);
};

// Browser
export const startBrowser = (headless = false) => api.post('/browser/start', { headless }).then(r => r.data);
export const getBrowserStatus = () => api.get<BrowserStatus>('/browser/status').then(r => r.data);

// Capture
export const captureCurrent = () => api.post<CaptureResult>('/candidates/capture-current').then(r => r.data);

// Outreach
export const createDraft = (matchId: number) => api.post<DraftResult>(`/outreach/${matchId}/draft`).then(r => r.data);
export const updateStatus = (matchId: number, status: string) => api.patch(`/outreach/${matchId}/status`, { status }).then(r => r.data);
export const bulkUpdateStatus = (matchIds: number[], status: string) =>
  api.patch<{ updated: number; status: string }>('/outreach/bulk-status', { match_ids: matchIds, status }).then(r => r.data);

// Batch Search
export const batchSearch = (keywords?: string[], city?: string, count_per_keyword?: number) =>
  api.post<BatchSearchResult>('/candidates/batch-search', { keywords, city, count_per_keyword }).then(r => r.data);

export const batchScore = (expectIds?: string[]) =>
  api.post('/candidates/batch-score', { expect_ids: expectIds }).then(r => r.data);

export const enqueueCandidate = (expectId: string, jobId: string) =>
  api.post<{ match_id: number; status: string; created: boolean }>('/candidates/enqueue', { expect_id: expectId, job_id: jobId }).then(r => r.data);

// Search profile config (single source of truth for default keywords / city)
export interface SearchProfile {
  keywords?: string[];
  job?: { title?: string; salary?: string; city?: string; experience?: string };
  [key: string]: any;
}

export const getProfile = () => api.get<SearchProfile>('/config/profile').then(r => r.data);

// LLM 精评（国产模型重排入围名单）
export interface LlmRerankResult {
  configured: boolean;
  scored?: number;
  total?: number;
  skipped_existing?: number;
  job_title?: string;
  message?: string;
  error?: string;
}

export const llmRerank = (jobId?: string, limit = 60) =>
  api.post<LlmRerankResult>('/ext/llm-rerank', { job_id: jobId || null, limit }, { timeout: 180000 })
    .then(r => r.data);

// 清理数据库（候选人/匹配/触达/页面快照，岗位配置保留）
export const resetDb = () =>
  api.delete<{ deleted: Record<string, number> }>('/config/reset-db').then(r => r.data);

// 跳转到 BOSS：请求油猴脚本在候选人卡片仍在屏幕上时自动点开并切前台（尽力而为）
export const openCandidateInBoss = (bossId: string, name: string) =>
  api.post<{ ok: boolean; error?: string }>('/ext/open-candidate', { boss_id: bossId, name }).then(r => r.data);

export default api;
