import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { homeFor } from '../App';
import { ROLE_LABELS } from '../ui';
import type { DemoUser } from '../types';

export default function LoginPage() {
  const { user, login } = useAuth();
  const navigate = useNavigate();
  const [users, setUsers] = useState<DemoUser[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    api<{ users: DemoUser[] }>('/auth/demo-users')
      .then((data) => setUsers(data.users))
      .catch((err: Error) => setError(err.message));
  }, []);

  async function choose(demoUser: DemoUser) {
    setBusyId(demoUser.id);
    setError(null);
    try {
      const result = await api<{ token: string; user: DemoUser }>('/auth/demo-login', {
        method: 'POST',
        body: JSON.stringify({ userId: demoUser.id }),
      });
      login(result.token, result.user);
      navigate(homeFor(result.user.role), { replace: true });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <div className="card">
        <h1 className="text-xl font-bold">Demo login</h1>
        <p className="mt-1 text-sm text-slate-600">
          Pick a seeded demo user. The backend still enforces role restrictions and district scoping for every request -
          switching users is only a shortcut for the demo.
        </p>
        {user && (
          <p className="mt-2 text-sm text-blue-700">
            Currently signed in as {user.name}. Choosing another user replaces the session.
          </p>
        )}
        {error && <p className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {users.map((demoUser) => (
          <button
            key={demoUser.id}
            onClick={() => choose(demoUser)}
            disabled={busyId !== null}
            className="card text-left transition hover:border-blue-400 hover:shadow-md disabled:opacity-60"
          >
            <div className="flex items-center justify-between">
              <span className="text-lg font-semibold">{demoUser.name}</span>
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">
                {ROLE_LABELS[demoUser.role]}
              </span>
            </div>
            <div className="mt-1 text-sm text-slate-500">{demoUser.email}</div>
            <div className="mt-1 text-xs text-slate-500">
              {[
                demoUser.district ? `District: ${demoUser.district}` : null,
                demoUser.trainingCentre?.name ?? null,
                !demoUser.district && !demoUser.trainingCentre ? 'State-wide' : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </div>
          </button>
        ))}
      </div>
      {!users.length && !error && <div className="card text-sm text-slate-500">Loading demo users...</div>}
    </div>
  );
}
