import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { StatusPill, formatDate, ErrorBox } from '../ui';
import type { BatchListItem } from '../types';

export default function StateQueuePage() {
  const { user } = useAuth();
  const [batches, setBatches] = useState<BatchListItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    api<{ batches: BatchListItem[] }>('/batches')
      .then((data) => setBatches(data.batches))
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, [refreshKey]);

  const pending = batches.filter((batch) => batch.status === 'PENDING_STATE');
  const issued = batches.filter((batch) => batch.status === 'ISSUED' || batch.status === 'APPROVED');
  const closed = batches.filter((batch) => batch.status === 'RETURNED' || batch.status === 'REJECTED');

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">
            {user?.role === 'STATE_OFFICE' ? 'State office - final approval' : 'All submitted batches'}
          </h1>
          <p className="text-sm text-slate-600">
            {user?.role === 'STATE_OFFICE'
              ? 'Give final approval to issue certificates, or revoke certificates that are already issued.'
              : 'Read-only overview for the quality team.'}
          </p>
        </div>
        <button className="btn-secondary" onClick={() => setRefreshKey((key) => key + 1)}>
          Refresh
        </button>
      </div>

      {error && <ErrorBox message={error} />}

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Awaiting final approval</h2>
        <div className="card overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Reference</th>
                <th>District</th>
                <th>Training centre</th>
                <th>Course</th>
                <th>Candidates</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {pending.map((batch) => (
                <tr key={batch.id}>
                  <td className="font-medium">{batch.reference}</td>
                  <td>{batch.district}</td>
                  <td>{batch.trainingCentre.name}</td>
                  <td>{batch.course}</td>
                  <td>{batch.candidateCount}</td>
                  <td>
                    <StatusPill status={batch.status} />
                  </td>
                  <td>
                    <Link className="text-sm font-medium text-blue-700 hover:underline" to={`/batch/${batch.id}`}>
                      Review
                    </Link>
                  </td>
                </tr>
              ))}
              {!pending.length && (
                <tr>
                  <td colSpan={7} className="py-6 text-center text-sm text-slate-500">
                    {loading ? 'Loading...' : 'Nothing awaiting final approval.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Issued certificates</h2>
        <div className="card overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Reference</th>
                <th>Training centre</th>
                <th>Certificates</th>
                <th>Status</th>
                <th>Issued</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {issued.map((batch) => (
                <tr key={batch.id}>
                  <td className="font-medium">{batch.reference}</td>
                  <td>{batch.trainingCentre.name}</td>
                  <td>{batch.certificates.length || batch.candidateCount}</td>
                  <td>
                    <StatusPill status={batch.status} />
                  </td>
                  <td>{formatDate(batch.issuedAt)}</td>
                  <td>
                    <Link className="text-sm font-medium text-blue-700 hover:underline" to={`/batch/${batch.id}`}>
                      Open
                    </Link>
                  </td>
                </tr>
              ))}
              {!issued.length && (
                <tr>
                  <td colSpan={6} className="py-4 text-center text-sm text-slate-500">
                    No issued batches yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {closed.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Returned / rejected</h2>
          <div className="card overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Reference</th>
                  <th>District</th>
                  <th>Status</th>
                  <th>Reason</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {closed.map((batch) => (
                  <tr key={batch.id}>
                    <td className="font-medium">{batch.reference}</td>
                    <td>{batch.district}</td>
                    <td>
                      <StatusPill status={batch.status} />
                    </td>
                    <td className="text-xs text-slate-500">{batch.rejectionReason ?? '-'}</td>
                    <td>
                      <Link className="text-sm font-medium text-blue-700 hover:underline" to={`/batch/${batch.id}`}>
                        Open
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
