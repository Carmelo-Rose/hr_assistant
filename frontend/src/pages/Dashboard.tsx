import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  getQueue,
  listJobs,
  createDraft,
  updateStatus,
  bulkUpdateStatus,
  llmRerank,
  resetDb,
  openCandidateInBoss,
  type QueueItem,
  type Job,
} from '../api';

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

function ConfirmDialog({ message, onConfirm, onCancel }: { message: string; onConfirm: () => void; onCancel: () => void }) {
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30" onClick={onCancel}>
      <div className="bg-white rounded-xl shadow-xl p-5 w-80" onClick={e => e.stopPropagation()}>
        <p className="text-sm text-gray-700">{message}</p>
        <div className="flex justify-end gap-2 mt-4">
          <button onClick={onCancel} className="px-3 py-1.5 text-xs font-medium text-gray-600 rounded-lg hover:bg-gray-100">
            取消
          </button>
          <button onClick={onConfirm} className="px-3 py-1.5 text-xs font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700">
            确认
          </button>
        </div>
      </div>
    </div>
  );
}

function CheckBadges({ item }: { item: QueueItem }) {
  const checks = [
    { label: '年龄', pass: item.age_pass },
    { label: '经验', pass: item.experience_match },
    { label: '能力', pass: item.capability_match },
  ];
  return (
    <div className="flex gap-1.5 mt-1">
      {checks.map(c => (
        <span key={c.label} className={`px-1.5 py-0.5 rounded text-[11px] font-medium ${
          c.pass ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-600'
        }`}>
          {c.label} {c.pass ? '✓' : '✗'}
        </span>
      ))}
    </div>
  );
}

function InfoLine({ item }: { item: QueueItem }) {
  const parts = [
    item.age != null ? `${item.age}岁` : '',
    item.work_years,
    item.education,
    item.salary_range,
    item.expected_city,
    item.job_status,
  ].filter(Boolean);
  if (!parts.length) return null;
  return <div className="text-xs text-gray-500 mt-1">{parts.join(' · ')}</div>;
}

function SkillTags({ skills }: { skills: string }) {
  if (!skills) return null;
  const tags = skills.split(',').map(s => s.trim()).filter(Boolean).slice(0, 6);
  if (!tags.length) return null;
  return (
    <div className="flex flex-wrap gap-1 mt-1.5">
      {tags.map(t => (
        <span key={t} className="px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 text-[11px]">{t}</span>
      ))}
    </div>
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
  const [jobFilter, setJobFilter] = useState('');
  const [view, setView] = useState<'active' | 'skipped'>('active');
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [copiedId, setCopiedId] = useState<number | null>(null);

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
    onSuccess: (data, matchId) => {
      setDrafts(prev => ({ ...prev, [matchId]: data.draft_text }));
      queryClient.invalidateQueries({ queryKey: ['queue'] });
    },
  });

  const copyDraft = async (matchId: number, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(matchId);
      setTimeout(() => setCopiedId(id => (id === matchId ? null : id)), 1500);
    } catch { /* clipboard permission denied, ignore */ }
  };

  const statusMutation = useMutation({
    mutationFn: ({ matchId, status }: { matchId: number; status: string }) => updateStatus(matchId, status),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['queue'] }),
  });

  const bulkMutation = useMutation({
    mutationFn: ({ matchIds, status }: { matchIds: number[]; status: string }) => bulkUpdateStatus(matchIds, status),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['queue'] }),
  });

  const [pendingBulk, setPendingBulk] = useState<{ status: string; matchIds: number[]; message: string } | null>(null);

  const [resetMsg, setResetMsg] = useState<string | null>(null);
  const [resetStep, setResetStep] = useState<0 | 1 | 2>(0); // 0=未开始 1=第一次确认 2=第二次确认
  const resetMutation = useMutation({
    mutationFn: resetDb,
    onSuccess: (res) => {
      const total = Object.values(res.deleted).reduce((a, b) => a + b, 0);
      setResetMsg(`数据库已清空，共删除 ${total} 条记录`);
      queryClient.invalidateQueries({ queryKey: ['queue'] });
    },
    onError: (e: any) => setResetMsg('清理失败：' + (e?.message || '请求出错')),
  });

  const [rerankMsg, setRerankMsg] = useState<string | null>(null);
  const rerankMutation = useMutation({
    mutationFn: () => llmRerank(jobFilter || undefined),
    onSuccess: (res) => {
      if (res.error) setRerankMsg(res.error);
      else if (!res.scored) setRerankMsg(res.message || '没有可精评的候选人');
      else setRerankMsg(
        `AI 精评完成：新评 ${res.scored}/${res.total} 人${res.skipped_existing ? `，跳过已评 ${res.skipped_existing} 人` : ''}`,
      );
      queryClient.invalidateQueries({ queryKey: ['queue'] });
    },
    onError: (e: any) => setRerankMsg('AI 精评失败：' + (e?.message || '请求出错')),
  });

  const [bossJumpMsg, setBossJumpMsg] = useState<string | null>(null);
  const bossJumpMutation = useMutation({
    mutationFn: ({ bossId, name }: { bossId: string; name: string }) => openCandidateInBoss(bossId, name),
    onSuccess: (res, { name }) => {
      setBossJumpMsg(res.ok
        ? `已请求跳转到 ${name}，若 BOSS 标签页里该候选人卡片仍在屏幕上会自动切前台`
        : (res.error || '请求失败'));
      setTimeout(() => setBossJumpMsg(null), 4000);
    },
    onError: () => {
      setBossJumpMsg('跳转请求失败，请确认后端已启动');
      setTimeout(() => setBossJumpMsg(null), 4000);
    },
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
            {view === 'active' ? (
              <>
                <button
                  onClick={() => { setRerankMsg(null); rerankMutation.mutate(); }}
                  disabled={rerankMutation.isPending || !queue?.length}
                  className="px-3 py-1.5 text-xs font-medium bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-40"
                  title="只对尚未有 AI 分数的候选人进行精评"
                >
                  {rerankMutation.isPending ? 'AI 精评中…' : 'AI 精评'}
                </button>
                <button
                  onClick={() => {
                    if (!queue?.length) return;
                    setPendingBulk({
                      status: 'skipped',
                      matchIds: queue.map((i: QueueItem) => i.match_id),
                      message: `确认跳过当前 ${queue.length} 位候选人？可在"已跳过"里一键恢复。`,
                    });
                  }}
                  disabled={bulkMutation.isPending || !queue?.length}
                  className="px-3 py-1.5 text-xs font-medium bg-gray-100 text-gray-600 rounded-lg hover:bg-gray-200 disabled:opacity-40"
                >
                  一键跳过
                </button>
              </>
            ) : (
              <button
                onClick={() => {
                  if (!queue?.length) return;
                  setPendingBulk({
                    status: 'new',
                    matchIds: queue.map((i: QueueItem) => i.match_id),
                    message: `确认恢复当前 ${queue.length} 位候选人到队列？`,
                  });
                }}
                disabled={bulkMutation.isPending || !queue?.length}
                className="px-3 py-1.5 text-xs font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-40"
              >
                一键恢复队列
              </button>
            )}
            <span className="text-sm text-gray-500">{queue?.length || 0} 人</span>
            <button
              onClick={() => { setResetMsg(null); setResetStep(1); }}
              disabled={resetMutation.isPending}
              className="px-3 py-1.5 text-xs font-medium bg-red-50 text-red-600 rounded-lg hover:bg-red-100 disabled:opacity-40"
              title="清空候选人/匹配/触达数据，岗位配置不受影响"
            >
              清理数据库
            </button>
          </div>
        </div>
        {rerankMsg && (
          <div className="px-4 py-2 text-xs text-indigo-700 bg-indigo-50 border-b border-indigo-100">{rerankMsg}</div>
        )}
        {resetMsg && (
          <div className="px-4 py-2 text-xs text-red-700 bg-red-50 border-b border-red-100">{resetMsg}</div>
        )}
        {bossJumpMsg && (
          <div className="px-4 py-2 text-xs text-blue-700 bg-blue-50 border-b border-blue-100">{bossJumpMsg}</div>
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
              <div
                key={item.match_id}
                onClick={() => {
                  if (!item.boss_id) return;
                  bossJumpMutation.mutate({ bossId: item.boss_id, name: item.name });
                }}
                className={`p-4 hover:bg-gray-50 transition-colors ${item.boss_id ? 'cursor-pointer' : ''}`}
                title={item.boss_id ? '点击跳转到 BOSS（若该卡片仍在 BOSS 标签页上）' : undefined}
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-gray-900 truncate">
                        {item.name}
                      </span>
                      <ScoreBadge score={item.score} />
                      {item.llm_score != null && <LlmBadge score={item.llm_score} />}
                      {view !== 'skipped' && <StatusBadge status={item.status} />}
                      {item.active_status && (
                        <span className="text-xs text-gray-400">{item.active_status}</span>
                      )}
                    </div>
                    <InfoLine item={item} />
                    <CheckBadges item={item} />
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
                    <SkillTags skills={item.skills} />
                    {drafts[item.match_id] && (
                      <div
                        className="mt-2 bg-purple-50 border border-purple-100 rounded-lg p-2.5 text-xs text-gray-700 whitespace-pre-wrap"
                        onClick={e => e.stopPropagation()}
                      >
                        {drafts[item.match_id]}
                        <div className="mt-1.5">
                          <button
                            onClick={() => copyDraft(item.match_id, drafts[item.match_id])}
                            className="px-2 py-0.5 text-xs bg-purple-100 text-purple-700 rounded hover:bg-purple-200"
                          >
                            {copiedId === item.match_id ? '已复制' : '复制话术'}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 ml-4 shrink-0" onClick={e => e.stopPropagation()}>
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
                          disabled={actionLoading !== null}
                          className="px-2.5 py-1 text-xs bg-green-50 text-green-700 rounded-md hover:bg-green-100 disabled:opacity-40"
                          title="已在 BOSS 上打过招呼？点这个标记，不要求先在这里生成话术"
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

      {pendingBulk && (
        <ConfirmDialog
          message={pendingBulk.message}
          onCancel={() => setPendingBulk(null)}
          onConfirm={() => {
            bulkMutation.mutate({ matchIds: pendingBulk.matchIds, status: pendingBulk.status });
            setPendingBulk(null);
          }}
        />
      )}

      {resetStep === 1 && (
        <ConfirmDialog
          message="确认要清空数据库吗？这会删除所有候选人、匹配结果和触达记录（岗位配置保留）。此操作不可恢复。"
          onCancel={() => setResetStep(0)}
          onConfirm={() => setResetStep(2)}
        />
      )}
      {resetStep === 2 && (
        <ConfirmDialog
          message="再次确认：数据清空后无法找回，确定继续吗？"
          onCancel={() => setResetStep(0)}
          onConfirm={() => {
            setResetStep(0);
            resetMutation.mutate();
          }}
        />
      )}
    </div>
  );
}
