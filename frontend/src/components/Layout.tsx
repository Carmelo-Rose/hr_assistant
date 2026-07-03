import { Outlet, Link, useLocation } from 'react-router-dom';
import { useEffect, useRef, useState } from 'react';
import CandidateDetail from './CandidateDetail';
import type { QueueItem } from '../api';

export default function Layout() {
  const location = useLocation();
  const [selectedCandidate, setSelectedCandidate] = useState<QueueItem | null>(null);
  const drawerRef = useRef<HTMLDivElement>(null);

  // Close the detail drawer whenever the route changes (e.g. top nav click).
  useEffect(() => {
    setSelectedCandidate(null);
  }, [location.pathname]);

  // Close on click outside the drawer. Uses mousedown (fires before a row's
  // own click handler) so clicking a different row still switches candidates
  // instead of being cancelled out by this closing first.
  useEffect(() => {
    if (!selectedCandidate) return;
    const handleMouseDown = (e: MouseEvent) => {
      if (drawerRef.current && !drawerRef.current.contains(e.target as Node)) {
        setSelectedCandidate(null);
      }
    };
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [selectedCandidate]);

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
                {navLink('/jobs', '岗位配置')}
                {navLink('/onboarding', '安装指引')}
              </nav>
            </div>
          </div>
        </div>
      </header>
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        <Outlet context={{ selectedCandidate, setSelectedCandidate }} />
      </main>

      {selectedCandidate && (
        <div ref={drawerRef}>
          <CandidateDetail
            item={selectedCandidate}
            onClose={() => setSelectedCandidate(null)}
          />
        </div>
      )}
    </div>
  );
}
