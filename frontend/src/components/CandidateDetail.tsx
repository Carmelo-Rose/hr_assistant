import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createDraft, fillChat, updateStatus, type QueueItem } from '../api';

interface Props {
  item: QueueItem;
  onClose: () => void;
}

export default function CandidateDetail({ item, onClose }: Props) {
  const queryClient = useQueryClient();

  const draftMutation = useMutation({
    mutationFn: () => createDraft(item.match_id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['queue'] }),
  });

  const fillMutation = useMutation({
    mutationFn: () => fillChat(item.match_id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['queue'] }),
  });

  const statusMutation = useMutation({
    mutationFn: (status: string) => updateStatus(item.match_id, status),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['queue'] }),
  });

  return (
    <div className="fixed inset-y-0 right-0 w-96 bg-white border-l border-gray-200 shadow-xl z-50 flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
        <div>
          <h3 className="font-semibold text-gray-900">{item.name}</h3>
          <p className="text-xs text-gray-500">{item.job_title}</p>
        </div>
        <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded-lg">
          <svg className="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Score Section */}
        <section>
          <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">匹配评分</h4>
          <div className="flex items-center gap-2">
            <span className={`text-2xl font-bold ${
              item.score >= 80 ? 'text-green-600' : item.score >= 60 ? 'text-yellow-600' : 'text-red-600'
            }`}>{item.score}</span>
            <span className="text-sm text-gray-400">/ 100</span>
          </div>
          <div className="flex gap-2 mt-2">
            {[
              { label: '年龄', pass: item.age_pass },
              { label: '经验', pass: item.experience_match },
              { label: '能力', pass: item.capability_match },
            ].map(d => (
              <span key={d.label} className={`px-2 py-0.5 rounded text-xs font-medium ${
                d.pass ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-600'
              }`}>
                {d.label} {d.pass ? '✓' : '✗'}
              </span>
            ))}
          </div>
        </section>

        {/* Match Reason */}
        {item.match_reason && (
          <section>
            <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">匹配理由</h4>
            <p className="text-sm text-gray-700 whitespace-pre-wrap">{item.match_reason}</p>
          </section>
        )}

        {/* Missing Info Warning */}
        {item.missing_info && (
          <section className="bg-amber-50 border border-amber-200 rounded-lg p-3">
            <h4 className="text-xs font-semibold text-amber-700 uppercase tracking-wider mb-1">缺失/风险信息</h4>
            <p className="text-sm text-amber-800">{item.missing_info}</p>
          </section>
        )}

        {/* Candidate Basic Info */}
        <section>
          <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">基本信息</h4>
          <div className="grid grid-cols-2 gap-2 text-sm">
            <div><span className="text-gray-400">活跃状态</span><br /><span className="text-gray-700">{item.active_status || '-'}</span></div>
            <div><span className="text-gray-400">匹配岗位</span><br /><span className="text-gray-700">{item.job_title}</span></div>
          </div>
        </section>

        {/* Draft / Actions */}
        <section className="space-y-2">
          <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">操作</h4>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => draftMutation.mutate()}
              disabled={item.status === 'sent_manual' || item.status === 'skipped'}
              className="flex-1 px-3 py-2 text-sm bg-purple-600 text-white rounded-lg hover:bg-purple-700 disabled:opacity-40"
            >
              生成话术
            </button>
            <button
              onClick={() => fillMutation.mutate()}
              disabled={!['drafted', 'filled'].includes(item.status)}
              className="flex-1 px-3 py-2 text-sm bg-teal-600 text-white rounded-lg hover:bg-teal-700 disabled:opacity-40"
            >
              填入输入框
            </button>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => statusMutation.mutate('sent_manual')}
              disabled={!['drafted', 'filled'].includes(item.status)}
              className="flex-1 px-3 py-2 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-40"
            >
              标记已发送
            </button>
            <button
              onClick={() => statusMutation.mutate('skipped')}
              className="flex-1 px-3 py-2 text-sm bg-gray-200 text-gray-600 rounded-lg hover:bg-gray-300"
            >
              跳过
            </button>
          </div>
        </section>

        {/* Draft Preview */}
        {draftMutation.data && (
          <section>
            <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">生成话术</h4>
            <div className="bg-gray-50 border border-gray-200 rounded-lg p-3 text-sm text-gray-700 whitespace-pre-wrap">
              {draftMutation.data.draft_text}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}