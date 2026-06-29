import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useOutletContext } from 'react-router-dom';
import {
  getQueue,
  listJobs,
  startBrowser,
  getBrowserStatus,
  captureCurrent,
  createDraft,
  fillChat,
  updateStatus,
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

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    new: 'bg-gray-100 text-gray-600',
    queued: 'bg-blue-100 text-blue-700',
    drafted: 'bg-purple-100 text-purple-700',
    filled: 'bg-teal-100 text-teal-700',
    sent_manual: 'bg-green-100 text-green-700',
    skipped: 'bg-gray-200 text-gray-400',
  };
  const labels: Record<string, string> = {
    new: '新',
    queued: '队列',
    drafted: '已草稿',
    filled: '已填入',
    sent_manual: '已发送',
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
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [captureResult, setCaptureResult] = useState<string | null>(null);
  const [browserWarning, setBrowserWarning] = useState<string | null>(null);

  // Queries
  const { data: jobs } = useQuery({ queryKey: ['jobs'], queryFn: listJobs });
  const { data: queue, isLoading: queueLoading } = useQuery({
    queryKey: ['queue', jobFilter],
    queryFn: () => getQueue(jobFilter || undefined),
    refetchInterval: 10_000,
  });
  const { data: browserStatus } = useQuery({
    queryKey: ['browser-status'],
    queryFn: getBrowserStatus,
    refetchInterval: 5_000,
  });

  // Mutations
  const captureMutation = useMutation({
    mutationFn: captureCurrent,
    onSuccess: (data) => {
      setCaptureResult(`采集成功: ${data.name}，匹配 ${data.match_count} 个岗位`);
      queryClient.invalidateQueries({ queryKey: ['queue'] });
    },
    onError: (err: any) => setCaptureResult(`采集失败: ${err.response?.data?.detail || err.message}`),
  });

  const draftMutation = useMutation({
    mutationFn: createDraft,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['queue'] }),
  });

  const fillMutation = useMutation({
    mutationFn: fillChat,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['queue'] }),
  });

  const statusMutation = useMutation({
    mutationFn: ({ matchId, status }: { matchId: number; status: string }) => updateStatus(matchId, status),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['queue'] }),
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
      {/* Browser & Capture Controls */}
      <div className="bg-white rounded-xl border border-gray-200 p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-3">
            <h2 className="font-semibold text-gray-900">浏览器</h2>
            <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${
              browserStatus?.running ? 'bg-green-50 text-green-700' : 'bg-gray-100 text-gray-500'
            }`}>
              <span className={`w-1.5 h-1.5 rounded-full ${browserStatus?.running ? 'bg-green-500' : 'bg-gray-400'}`} />
              {browserStatus?.running ? `运行中 (${browserStatus.page_count} 页)` : '未启动'}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={async () => {
              setActionLoading('startBrowser');
              setBrowserWarning(null);
              try {
                const res = await startBrowser(false);
                if (res.warning) setBrowserWarning(res.warning);
              } finally {
                setActionLoading(null);
                queryClient.invalidateQueries({ queryKey: ['browserStatus'] });
              }
            }}
            disabled={actionLoading !== null}
            className={`px-3 py-1.5 text-sm rounded-lg disabled:opacity-50 disabled:cursor-not-allowed ${
              browserStatus?.running
                ? 'bg-orange-100 text-orange-700 hover:bg-orange-200'
                : 'bg-blue-600 text-white hover:bg-blue-700'
            }`}
          >
            {actionLoading === 'startBrowser' ? '连接中…' : browserStatus?.running ? '重启浏览器' : '启动浏览器'}
          </button>
          <button
            onClick={() => handleAction('capture', () => captureMutation.mutateAsync())}
            disabled={actionLoading !== null || !browserStatus?.running}
            className="px-3 py-1.5 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            采集当前页面
          </button>
          {captureResult && (
            <span className={`text-sm ml-2 ${captureResult.includes('失败') ? 'text-red-600' : 'text-green-600'}`}>
              {captureResult}
            </span>
          )}
        </div>
        {browserWarning && (
          <div className="mt-3 flex items-start gap-2 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2.5 text-sm text-amber-800">
            <span className="mt-0.5 shrink-0">⚠️</span>
            <span className="whitespace-pre-wrap">{browserWarning}</span>
          </div>
        )}
      </div>

      {/* Queue */}
      <div className="bg-white rounded-xl border border-gray-200">
        <div className="p-4 border-b border-gray-100 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h2 className="font-semibold text-gray-900">今日触达队列</h2>
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
          </div>
          <span className="text-sm text-gray-500">{queue?.length || 0} 人</span>
        </div>

        {queueLoading ? (
          <div className="p-8 text-center text-gray-400">加载中...</div>
        ) : !queue?.length ? (
          <div className="p-8 text-center text-gray-400">
            <p className="text-lg mb-1">队列为空</p>
            <p className="text-sm">先启动浏览器 → 打开 BOSS 候选人详情页 → 点击"采集当前页面"</p>
          </div>
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
                      <StatusBadge status={item.status} />
                      {item.active_status && (
                        <span className="text-xs text-gray-400">{item.active_status}</span>
                      )}
                    </div>
                    <div className="text-xs text-gray-500 mt-1">
                      匹配岗位: <span className="font-medium">{item.job_title}</span>
                    </div>
                    {item.match_reason && (
                      <div className="text-xs text-gray-500 mt-0.5 line-clamp-1">{item.match_reason}</div>
                    )}
                    <MissingWarning info={item.missing_info} />
                  </div>
                  <div className="flex items-center gap-1.5 ml-4 shrink-0">
                    <button
                      onClick={() => handleAction(`draft-${item.match_id}`, () => draftMutation.mutateAsync(item.match_id))}
                      disabled={actionLoading !== null || item.status === 'sent_manual' || item.status === 'skipped'}
                      className="px-2.5 py-1 text-xs bg-purple-50 text-purple-700 rounded-md hover:bg-purple-100 disabled:opacity-40"
                    >
                      生成话术
                    </button>
                    <button
                      onClick={() => handleAction(`fill-${item.match_id}`, () => fillMutation.mutateAsync(item.match_id))}
                      disabled={actionLoading !== null || !['drafted', 'filled'].includes(item.status)}
                      className="px-2.5 py-1 text-xs bg-teal-50 text-teal-700 rounded-md hover:bg-teal-100 disabled:opacity-40"
                    >
                      填入输入框
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