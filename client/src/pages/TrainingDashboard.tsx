import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { StatusPill, formatDate, ErrorBox } from '../ui';
import type { BatchListItem } from '../types';

export default function TrainingDashboard() {
  const [batches, setBatches] = useState<BatchListItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api<{ batches: BatchListItem[] }>('/batches')
      .then((data) => setBatches(data.batches))
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  const counts = batches.reduce<Record<string, number>>((acc, batch) => {
    acc[batch.status] = (acc[batch.status] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">My batches</h1>
          <p className="text-sm text-slate-600">Upload candidates, submit batches and track approvals.</p>
        </div>
        <Link to="/upload" className="btn-primary">
          Upload candidate batch
        </Link>
      </div>

      {error && <ErrorBox message={error} />}

      <div className="grid gap-3 sm:grid-cols-4">
        {[
          { label: 'Draft', key: 'DRAFT' },
          { label: 'Pending district', key: 'PENDING_DISTRICT' },
          { label: 'Pending state', key: 'PENDING_STATE' },
          { label: 'Issued', key: 'ISSUED' },
        ].map((item) => (
          <div key={item.key} className="card">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{item.label}</div>
            <div className="mt-1 text-2xl font-bold">{counts[item.key] ?? 0}</div>
          </div>
        ))}
      </div>

      <div className="card overflow-x-auto">
        <table className="table">
          <thead>
            <tr>
              <th>Reference</th>
              <th>Course</th>
              <th>Candidates</th>
              <th>Status</th>
              <th>Round</th>
              <th>Submitted</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {batches.map((batch) => (
              <tr key={batch.id}>
                <td className="font-medium">{batch.reference}</td>
                <td>{batch.course}</td>
                <td>{batch.candidateCount}</td>
                <td>
                  <StatusPill status={batch.status} />
                  {batch.rejectionReason && (
                    <div className="mt-1 max-w-xs text-xs text-slate-500">{batch.rejectionReason}</div>
                  )}
                </td>
                <td>{batch.roundNumber}</td>
                <td>{formatDate(batch.submittedAt)}</td>
                <td>
                  <Link className="text-sm font-medium text-blue-700 hover:underline" to={`/batch/${batch.id}`}>
                    Open
                  </Link>
                </td>
              </tr>
            ))}
            {!batches.length && !loading && (
              <tr>
                <td colSpan={7} className="py-6 text-center text-sm text-slate-500">
                  No batches yet. Upload a CSV to create your first batch.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
