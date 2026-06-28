import { useState, useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { listJobs, batchSearch, enqueueCandidate, getProfile, type BatchCandidate, type Job } from '../api';

// 兜底值：仅当 search_profile.yaml 拉取失败时使用
const FALLBACK_KEYWORDS = [
  '天猫运营', '淘宝运营', '电商运营',
  '拼多多运营', '抖音运营',
  '品牌运营', '电商项目经理', '网络推广',
];

function ScoreBadge({ score }: { score: number }) {
  const color =
    score >= 80 ? 'bg-green-100 text-green-800' :
    score >= 60 ? 'bg-yellow-100 text-yellow-800' :
    'bg-red-100 text-red-800';
  return <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${color}`}>{score}</span>;
}

export default function BatchSearch() {
  const queryClient = useQueryClient();
  const { data: jobs } = useQuery({ queryKey: ['jobs'], queryFn: listJobs });
  const { data: profile } = useQuery({ queryKey: ['profile'], queryFn: getProfile });
  const [keywords, setKeywords] = useState('');
  const [city, setCity] = useState('');
  const initialized = useRef(false);

  // 用 search_profile.yaml 初始化默认关键词/城市（单一数据源），仅首次填充
  useEffect(() => {
    if (!profile || initialized.current) return;
    const kws = profile.keywords?.length ? profile.keywords : FALLBACK_KEYWORDS;
    setKeywords(kws.join(', '));
    setCity(profile.job?.city || '');
    initialized.current = true;
  }, [profile]);
  const [result, setResult] = useState<BatchCandidate[] | null>(null);
  const [statusMsg, setStatusMsg] = useState('');
  const [searching, setSearching] = useState(false);
  const [enqueueing, setEnqueueing] = useState<string | null>(null);
  const [selectedJob, setSelectedJob] = useState('');

  const doSearch = async () => {
    setSearching(true);
    setStatusMsg('搜索中...');
    setResult(null);
    try {
      const kw = keywords.split(',').map(s => s.trim()).filter(Boolean);
      const res = await batchSearch(kw, city || undefined);
      setResult(res.top_candidates);
      setStatusMsg(`完成: 抓取 ${res.total_fetched} 人，新增 ${res.new_candidates} 人`);
    } catch (e: any) {
      setStatusMsg(`失败: ${e.response?.data?.detail || e.message}`);
    } finally {
      setSearching(false);
    }
  };

  const addToQueue = async (c: BatchCandidate) => {
    if (!selectedJob) return;
    setEnqueueing(c.expectId);
    try {
      await enqueueCandidate(c.expectId, selectedJob);
      queryClient.invalidateQueries({ queryKey: ['queue'] });
      setStatusMsg(`${c.name} 已加入队列`);
    } catch (e: any) {
      setStatusMsg(`加入队列失败: ${e.response?.data?.detail || e.message}`);
    } finally {
      setEnqueueing(null);
    }
  };

  return (
    <div className="space-y-6">
      {/* Search Controls */}
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">批量搜索候选人</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">关键词（逗号分隔）</label>
            <textarea
              value={keywords}
              onChange={e => setKeywords(e.target.value)}
              className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500 min-h-[60px]"
              placeholder="Java 开发, Golang 后端, ..."
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">城市</label>
            <input
              type="text"
              value={city}
              onChange={e => setCity(e.target.value)}
              className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="北京"
            />
            <label className="block text-xs font-medium text-gray-500 mt-3 mb-1">加入队列的目标岗位</label>
            <select
              value={selectedJob}
              onChange={e => setSelectedJob(e.target.value)}
              className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">选择岗位...</option>
              {jobs?.map((j: Job) => (
                <option key={j.id} value={j.id}>{j.title}</option>
              ))}
            </select>
          </div>
        </div>
        <div className="flex items-center gap-3 mt-4">
          <button
            onClick={doSearch}
            disabled={searching}
            className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {searching ? '搜索中...' : '开始搜索'}
          </button>
          {statusMsg && (
            <span className={`text-sm ${statusMsg.includes('失败') ? 'text-red-600' : 'text-gray-600'}`}>
              {statusMsg}
            </span>
          )}
        </div>
      </div>

      {/* Results */}
      {result && (
        <div className="bg-white rounded-xl border border-gray-200">
          <div className="p-4 border-b border-gray-100 flex items-center justify-between">
            <h2 className="font-semibold text-gray-900">搜索结果 ({result.length})</h2>
            <div className="flex items-center gap-2">
              {!selectedJob && (
                <span className="text-xs text-amber-600">请先选择目标岗位才能加入队列</span>
              )}
            </div>
          </div>
          <div className="divide-y divide-gray-100">
            {result.map(c => (
              <div key={c.expectId} className="p-4 hover:bg-gray-50 transition-colors">
                <div className="flex items-start justify-between">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-gray-900">{c.name}</span>
                      <ScoreBadge score={c.score} />
                      {c.jobStatus && (
                        <span className="text-xs text-gray-400">{c.jobStatus}</span>
                      )}
                    </div>
                    <div className="flex items-center gap-3 text-xs text-gray-500 mt-1">
                      <span>{c.company} · {c.title}</span>
                    </div>
                    <div className="flex items-center gap-3 text-xs text-gray-400 mt-0.5">
                      {c.age && <span>{c.age}岁</span>}
                      {c.education && <span>{c.education}</span>}
                      {c.salary && <span>{c.salary}</span>}
                      {c.experience && <span>{c.experience}</span>}
                    </div>
                    {c.skills?.length > 0 && (
                      <div className="flex items-center gap-1 mt-1 flex-wrap">
                        {c.skills.slice(0, 8).map(s => (
                          <span key={s} className="px-1.5 py-0.5 bg-gray-100 rounded text-xs text-gray-500">{s}</span>
                        ))}
                      </div>
                    )}
                    {c.details?.length > 0 && (
                      <div className="text-xs text-gray-400 mt-1">
                        评分明细: {c.details.join('；')}
                      </div>
                    )}
                  </div>
                  <div className="ml-4 shrink-0">
                    <button
                      onClick={() => addToQueue(c)}
                      disabled={enqueueing === c.expectId || !selectedJob}
                      className="px-3 py-1.5 text-xs bg-blue-50 text-blue-700 rounded-md hover:bg-blue-100 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      {enqueueing === c.expectId ? '添加中...' : '加入队列'}
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
