import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useOutletContext } from 'react-router-dom';
import {
  getQueue,
  listJobs,
  createDraft,
  updateStatus,
  llmRerank,
  type QueueItem,
  type Job,
} from '../api';

interface OutletCtx {
  selectedCandidate: QueueItem | null;
  setSelectedCandidate: (item: QueueItem | null) => void;
}

function ScoreBadge({ score }: { score: number }) {
  const color =
    score >= 80 ? 'bg-green-100 text-green-800' :
    score >= 60 ? 'bg-yellow-100 text-yellow-800' :
    'bg-red-100 text-red-800';
  return <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${color}`}>{score}</span>;
}

function LlmBadge({ score }: { score: number }) {
  const color =
    score >= 80 ? 'bg-indigo-100 text-indigo-800' :
    score >= 60 ? 'bg-violet-100 text-violet-700' :
    'bg-rose-100 text-rose-700';
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${color}`} title="AI 精评分">
      AI {score}
    </span>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    new: 'bg-gray-100 text-gray-600',
    queued: 'bg-blue-100 text-blue-700',
    drafted: 'bg-purple-100 text-purple-700',
    filled: 'bg-teal-100 text-teal-700',
    sent_manual: 'bg-green-100 text-green-700',
    sent_auto: 'bg-emerald-100 text-emerald-700',
    skipped: 'bg-gray-200 text-gray-400',
  };
  const labels: Record<string, string> = {
    new: '新',
    queued: '队列',
    drafted: '已草稿',
    filled: '已填入',
    sent_manual: '手动发送',
    sent_auto: '自动发送',
    skipped: '已跳过',
  };
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-medium ${colors[status] || 'bg-gray-100'}`}>
      {labels[status] || status}
    </span>
  );
}

function MissingWarning({ info }: { info: string }) {
  if (!info) return null;
  return (
    <div className="flex items-center gap-1 text-amber-600 text-xs mt-1">
      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
      </svg>
      <span>{info}</span>
    </div>
  );
}

export default function Dashboard() {
  const queryClient = useQueryClient();
  const { setSelectedCandidate } = useOutletContext<OutletCtx>();
  const [jobFilter, setJobFilter] = useState('');
  const [view, setView] = useState<'active' | 'skipped'>('active');
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  // Queries
  const { data: jobs } = useQuery({ queryKey: ['jobs'], queryFn: listJobs });
  const { data: queue, isLoading: queueLoading } = useQuery({
    queryKey: ['queue', jobFilter, view],
    queryFn: () => getQueue(jobFilter || undefined, view === 'skipped' ? 'skipped' : undefined),
    refetchInterval: 10_000,
  });

  // Mutations
  const draftMutation = useMutation({
    mutationFn: createDraft,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['queue'] }),
  });

  const statusMutation = useMutation({
    mutationFn: ({ matchId, status }: { matchId: number; status: string }) => updateStatus(matchId, status),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['queue'] }),
  });

  const [rerankMsg, setRerankMsg] = useState<string | null>(null);
  const rerankMutation = useMutation({
    mutationFn: () => llmRerank(jobFilter || undefined),
    onSuccess: (res) => {
      if (res.error) setRerankMsg(res.error);
      else if (!res.scored) setRerankMsg(res.message || '没有可精评的候选人');
      else setRerankMsg(`AI 精评完成：${res.scored}/${res.total} 人已重排`);
      queryClient.invalidateQueries({ queryKey: ['queue'] });
    },
    onError: (e: any) => setRerankMsg('AI 精评失败：' + (e?.message || '请求出错')),
  });

  const handleAction = async (action: string, fn: () => Promise<any>) => {
    setActionLoading(action);
    try {
      await fn();
    } finally {
      setActionLoading(null);
    }
  };

  return (
    <div className="space-y-6">
      {/* Queue */}
      <div className="bg-white rounded-xl border border-gray-200">
        <div className="p-4 border-b border-gray-100 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h2 className="font-semibold text-gray-900">{view === 'skipped' ? '已跳过' : '今日触达队列'}</h2>
            <select
              value={jobFilter}
              onChange={e => setJobFilter(e.target.value)}
              className="text-sm border border-gray-200 rounded-lg px-2 py-1 focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">全部岗位</option>
              {jobs?.map((j: Job) => (
                <option key={j.id} value={j.id}>{j.title}</option>
              ))}
            </select>
            <div className="flex rounded-lg border border-gray-200 overflow-hidden text-xs">
              <button
                onClick={() => setView('active')}
                className={`px-3 py-1 ${view === 'active' ? 'bg-blue-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
              >
                队列
              </button>
              <button
                onClick={() => setView('skipped')}
                className={`px-3 py-1 border-l border-gray-200 ${view === 'skipped' ? 'bg-blue-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
              >
                已跳过
              </button>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {view === 'active' && (
              <button
                onClick={() => { setRerankMsg(null); rerankMutation.mutate(); }}
                disabled={rerankMutation.isPending || !queue?.length}
                className="px-3 py-1.5 text-xs font-medium bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-40"
                title="用国产大模型对入围名单重新打分排序"
              >
                {rerankMutation.isPending ? 'AI 精评中…' : 'AI 精评'}
              </button>
            )}
            <span className="text-sm text-gray-500">{queue?.length || 0} 人</span>
          </div>
        </div>
        {rerankMsg && (
          <div className="px-4 py-2 text-xs text-indigo-700 bg-indigo-50 border-b border-indigo-100">{rerankMsg}</div>
        )}

        {queueLoading ? (
          <div className="p-8 text-center text-gray-400">加载中...</div>
        ) : !queue?.length ? (
          view === 'skipped' ? (
            <div className="p-8 text-center text-gray-400">
              <p className="text-lg mb-1">没有已跳过的候选人</p>
              <p className="text-sm">在队列里点"跳过"的人会进到这里，可随时恢复</p>
            </div>
          ) : (
            <div className="p-8 text-center text-gray-400">
              <p className="text-lg mb-1">队列为空</p>
              <p className="text-sm">用油猴脚本在 BOSS 页面扫描候选人，评分后自动进入队列</p>
              <a href="/onboarding" className="inline-block mt-3 text-sm text-blue-600 hover:underline">
                还没装脚本？查看安装指引 →
              </a>
            </div>
          )
        ) : (
          <div className="divide-y divide-gray-100">
            {queue.map((item: QueueItem) => (
              <div key={item.match_id} className="p-4 hover:bg-gray-50 transition-colors">
                <div className="flex items-start justify-between">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => setSelectedCandidate(item)}
                        className="text-sm font-medium text-gray-900 hover:text-blue-600 truncate"
                      >
                        {item.name}
                      </button>
                      <ScoreBadge score={item.score} />
                      {item.llm_score != null && <LlmBadge score={item.llm_score} />}
                      <StatusBadge status={item.status} />
                      {item.active_status && (
                        <span className="text-xs text-gray-400">{item.active_status}</span>
                      )}
                    </div>
                    <div className="text-xs text-gray-500 mt-1">
                      匹配岗位: <span className="font-medium">{item.job_title}</span>
                    </div>
                    {item.llm_reason && (
                      <div className="text-xs text-indigo-600 mt-0.5 line-clamp-1">AI: {item.llm_reason}</div>
                    )}
                    {item.match_reason && (
                      <div className="text-xs text-gray-500 mt-0.5 line-clamp-1">{item.match_reason}</div>
                    )}
                    <MissingWarning info={item.missing_info} />
                  </div>
                  <div className="flex items-center gap-1.5 ml-4 shrink-0">
                    {item.status === 'skipped' ? (
                      <button
                        onClick={() => handleAction(`restore-${item.match_id}`, () => statusMutation.mutateAsync({ matchId: item.match_id, status: 'new' }))}
                        disabled={actionLoading !== null}
                        className="px-2.5 py-1 text-xs bg-blue-50 text-blue-700 rounded-md hover:bg-blue-100 disabled:opacity-40"
                        title="恢复到队列（状态改回「新」）"
                      >
                        恢复到队列
                      </button>
                    ) : (
                      <>
                        <button
                          onClick={() => handleAction(`draft-${item.match_id}`, () => draftMutation.mutateAsync(item.match_id))}
                          disabled={actionLoading !== null || item.status === 'sent_manual' || item.status === 'sent_auto'}
                          className="px-2.5 py-1 text-xs bg-purple-50 text-purple-700 rounded-md hover:bg-purple-100 disabled:opacity-40"
                        >
                          生成话术
                        </button>
                        <button
                          onClick={() => handleAction(`sent-${item.match_id}`, () => statusMutation.mutateAsync({ matchId: item.match_id, status: 'sent_manual' }))}
                          disabled={actionLoading !== null || !['drafted', 'filled'].includes(item.status)}
                          className="px-2.5 py-1 text-xs bg-green-50 text-green-700 rounded-md hover:bg-green-100 disabled:opacity-40"
                        >
                          标记已发送
                        </button>
                        <button
                          onClick={() => handleAction(`skip-${item.match_id}`, () => statusMutation.mutateAsync({ matchId: item.match_id, status: 'skipped' }))}
                          disabled={actionLoading !== null}
                          className="px-2.5 py-1 text-xs bg-gray-50 text-gray-500 rounded-md hover:bg-gray-100 disabled:opacity-40"
                        >
                          跳过
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
