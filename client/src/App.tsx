import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useAuth } from './auth';
import { ROLE_LABELS } from './ui';
import type { Role } from './types';
import LoginPage from './pages/LoginPage';
import TrainingDashboard from './pages/TrainingDashboard';
import UploadBatchPage from './pages/UploadBatchPage';
import OfficerQueuePage from './pages/OfficerQueuePage';
import StateQueuePage from './pages/StateQueuePage';
import BatchDetailPage from './pages/BatchDetailPage';
import VerifyPage from './pages/VerifyPage';

export function homeFor(role: Role): string {
  switch (role) {
    case 'TRAINING_CENTRE':
      return '/dashboard';
    case 'DISTRICT_OFFICER':
      return '/officer';
    case 'STATE_OFFICE':
      return '/state';
    default:
      return '/state';
  }
}

function RequireAuth({ children, roles }: { children: ReactNode; roles?: Role[] }) {
  const { user } = useAuth();
  if (!user) return <Navigate to="/login" replace />;
  if (roles && !roles.includes(user.role)) return <Navigate to={homeFor(user.role)} replace />;
  return <>{children}</>;
}

function Layout({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();
  const location = useLocation();

  const links: Array<{ to: string; label: string }> = [];
  if (user?.role === 'TRAINING_CENTRE') {
    links.push({ to: '/dashboard', label: 'My batches' }, { to: '/upload', label: 'Upload batch' });
  }
  if (user?.role === 'DISTRICT_OFFICER') links.push({ to: '/officer', label: 'District approvals' });
  if (user?.role === 'STATE_OFFICE' || user?.role === 'QUALITY_TEAM') {
    links.push({ to: '/state', label: user.role === 'STATE_OFFICE' ? 'State approvals' : 'All batches' });
  }
  links.push({ to: '/verify', label: 'Public verification' });

  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-6">
            <Link to={user ? homeFor(user.role) : '/login'} className="text-lg font-bold text-blue-700">
              CertiFlow
            </Link>
            <nav className="flex flex-wrap gap-1">
              {links.map((link) => (
                <Link
                  key={link.to}
                  to={link.to}
                  className={`rounded-md px-3 py-1.5 text-sm ${
                    location.pathname === link.to
                      ? 'bg-blue-50 font-semibold text-blue-700'
                      : 'text-slate-600 hover:bg-slate-100'
                  }`}
                >
                  {link.label}
                </Link>
              ))}
            </nav>
          </div>
          <div className="flex items-center gap-3 text-sm">
            {user ? (
              <>
                <div className="text-right leading-tight">
                  <div className="font-semibold text-slate-800">{user.name}</div>
                  <div className="text-xs text-slate-500">
                    {ROLE_LABELS[user.role]}
                    {user.district ? ` · ${user.district}` : ''}
                    {user.trainingCentre ? ` · ${user.trainingCentre.name}` : ''}
                  </div>
                </div>
                <button className="btn-secondary" onClick={logout}>
                  Switch user
                </button>
              </>
            ) : (
              <Link className="btn-primary" to="/login">
                Demo login
              </Link>
            )}
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
    </div>
  );
}

export default function App() {
  const { user } = useAuth();

  return (
    <Layout>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/verify" element={<VerifyPage />} />
        <Route path="/verify/:token" element={<VerifyPage />} />
        <Route path="/" element={user ? <Navigate to={homeFor(user.role)} replace /> : <Navigate to="/login" replace />} />
        <Route
          path="/dashboard"
          element={
            <RequireAuth roles={['TRAINING_CENTRE']}>
              <TrainingDashboard />
            </RequireAuth>
          }
        />
        <Route
          path="/upload"
          element={
            <RequireAuth roles={['TRAINING_CENTRE']}>
              <UploadBatchPage />
            </RequireAuth>
          }
        />
        <Route
          path="/officer"
          element={
            <RequireAuth roles={['DISTRICT_OFFICER']}>
              <OfficerQueuePage />
            </RequireAuth>
          }
        />
        <Route
          path="/state"
          element={
            <RequireAuth roles={['STATE_OFFICE', 'QUALITY_TEAM']}>
              <StateQueuePage />
            </RequireAuth>
          }
        />
        <Route
          path="/batch/:id"
          element={
            <RequireAuth>
              <BatchDetailPage />
            </RequireAuth>
          }
        />
        <Route path="*" element={<div className="card">Page not found.</div>} />
      </Routes>
    </Layout>
  );
}
