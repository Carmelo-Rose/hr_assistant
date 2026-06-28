import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { listJobs, patchJob, type Job } from '../api';

export default function JobConfig() {
  const queryClient = useQueryClient();
  const { data: jobs, isLoading } = useQuery({ queryKey: ['jobs'], queryFn: listJobs });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<Partial<Job>>({});

  const patchMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<Job> }) => patchJob(id, data),
    onSuccess: () => {
      setEditingId(null);
      queryClient.invalidateQueries({ queryKey: ['jobs'] });
    },
  });

  const startEdit = (job: Job) => {
    setEditingId(job.id);
    setEditForm({ ...job });
  };

  if (isLoading) return <div className="text-gray-400 p-8">加载中...</div>;

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold text-gray-900">岗位配置</h2>
      {jobs?.map((job: Job) => {
        const isEditing = editingId === job.id;
        const form = isEditing ? editForm : job;
        return (
          <div key={job.id} className="bg-white rounded-xl border border-gray-200 p-5">
            {/* Header */}
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="font-semibold text-gray-900">{form.title || job.title}</h3>
                <span className="text-xs text-gray-400">{job.id}</span>
              </div>
              <button
                onClick={() => isEditing
                  ? patchMutation.mutate({ id: job.id, data: editForm })
                  : startEdit(job)
                }
                disabled={patchMutation.isPending}
                className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
              >
                {isEditing ? '保存' : '编辑'}
              </button>
            </div>

            {/* Fields */}
            <div className="grid grid-cols-2 gap-4 text-sm">
              <Field label="部门" value={form.department || ''} isEditing={isEditing} field="department" form={editForm} setForm={setEditForm} />
              <Field label="最高年龄" value={form.age_max?.toString() || ''} isEditing={isEditing} field="age_max" form={editForm} setForm={setEditForm} />
              <Field label="经验关键词" value={form.experience_keywords || ''} isEditing={isEditing} field="experience_keywords" form={editForm} setForm={setEditForm} />
              <Field label="能力关键词" value={form.capability_keywords || ''} isEditing={isEditing} field="capability_keywords" form={editForm} setForm={setEditForm} />
              <Field label="活跃时段" value={form.active_hours || ''} isEditing={isEditing} field="active_hours" form={editForm} setForm={setEditForm} />
            </div>

            {/* Template (full width) */}
            <div className="mt-4">
              <label className="block text-xs font-medium text-gray-500 mb-1">话术模板</label>
              {isEditing ? (
                <textarea
                  value={editForm.template || ''}
                  onChange={(e) => setEditForm(p => ({ ...p, template: e.target.value }))}
                  className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500 min-h-[80px]"
                />
              ) : (
                <div className="text-sm text-gray-600 bg-gray-50 rounded-lg px-3 py-2 whitespace-pre-wrap">
                  {form.template || '-'}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Field({
  label, value, isEditing, field, form, setForm,
}: {
  label: string;
  value: string;
  isEditing: boolean;
  field: string;
  form: Record<string, any>;
  setForm: (fn: (prev: any) => any) => void;
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-500 mb-1">{label}</label>
      {isEditing ? (
        <input
          type="text"
          value={form[field] ?? value}
          onChange={(e) => setForm(p => ({ ...p, [field]: field === 'age_max' ? parseInt(e.target.value) || 0 : e.target.value }))}
          className="w-full text-sm border border-gray-200 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      ) : (
        <div className="text-sm text-gray-700">{value || '-'}</div>
      )}
    </div>
  );
}