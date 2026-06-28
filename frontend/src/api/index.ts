import axios from 'axios';

const api = axios.create({
  baseURL: 'http://localhost:8000/api',
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
}

export interface Job {
  id: string;
  title: string;
  department: string;
  age_max: number;
  experience_keywords: string;
  capability_keywords: string;
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

export interface FillResult {
  outreach_id: number;
  filled: boolean;
  message: string;
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
export const fillChat = (matchId: number) => api.post<FillResult>(`/outreach/${matchId}/fill`).then(r => r.data);
export const updateStatus = (matchId: number, status: string) => api.patch(`/outreach/${matchId}/status`, { status }).then(r => r.data);

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

export default api;