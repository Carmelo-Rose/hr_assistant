import { Outlet, Link, useLocation } from 'react-router-dom';
import { useState } from 'react';
import CandidateDetail from './CandidateDetail';
import type { QueueItem } from '../api';

export default function Layout() {
  const location = useLocation();
  const [selectedCandidate, setSelectedCandidate] = useState<QueueItem | null>(null);

  const navLink = (path: string, label: string) => (
    <Link
      to={path}
      className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
        location.pathname === path
          ? 'bg-blue-600 text-white'
          : 'text-gray-600 hover:bg-gray-100'
      }`}
    >
      {label}
    </Link>
  );

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200 sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16">
            <div className="flex items-center gap-3">
              <h1 className="text-xl font-bold text-gray-900">BOSS 招聘助手</h1>
              <nav className="flex items-center gap-1 ml-8">
                {navLink('/dashboard', '今日队列')}
                {navLink('/batch-search', '批量搜索')}
                {navLink('/jobs', '岗位配置')}
              </nav>
            </div>
          </div>
        </div>
      </header>
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        <Outlet context={{ selectedCandidate, setSelectedCandidate }} />
      </main>

      {selectedCandidate && (
        <CandidateDetail
          item={selectedCandidate}
          onClose={() => setSelectedCandidate(null)}
        />
      )}
    </div>
  );
}