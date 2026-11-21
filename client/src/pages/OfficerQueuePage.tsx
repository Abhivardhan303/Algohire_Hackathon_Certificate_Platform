import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { StatusPill, formatDate, ErrorBox } from '../ui';
import type { BatchListItem } from '../types';

export default function OfficerQueuePage() {
  const [batches, setBatches] = useState<BatchListItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api<{ batches: BatchListItem[] }>('/batches')
      .then((data) => setBatches(data.batches))
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  const pending = batches.filter((batch) => batch.status === 'PENDING_DISTRICT');
  const other = batches.filter((batch) => batch.status !== 'PENDING_DISTRICT');

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold">District approvals</h1>
        <p className="text-sm text-slate-600">
          Only batches from your district are listed. A batch needs two different district officers to approve it.
        </p>
      </div>

      {error && <ErrorBox message={error} />}

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Awaiting your decision</h2>
        <div className="card overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Reference</th>
                <th>Training centre</th>
                <th>Course</th>
                <th>Candidates</th>
                <th>Approvals</th>
                <th>Submitted</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {pending.map((batch) => (
                <tr key={batch.id}>
                  <td className="font-medium">{batch.reference}</td>
                  <td>{batch.trainingCentre.name}</td>
                  <td>{batch.course}</td>
                  <td>{batch.candidateCount}</td>
                  <td>
                    <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-700">
                      {batch.ui.districtApprovals}/{batch.ui.requiredDistrictApprovals}
                    </span>
                    {batch.ui.myDecision && (
                      <span className="ml-2 text-xs text-slate-500">You: {batch.ui.myDecision}</span>
                    )}
                  </td>
                  <td>{formatDate(batch.submittedAt)}</td>
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
                    {loading ? 'Loading...' : 'No batches awaiting district approval.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Other batches in your district</h2>
        <div className="card overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Reference</th>
                <th>Training centre</th>
                <th>Status</th>
                <th>Updated</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {other.map((batch) => (
                <tr key={batch.id}>
                  <td className="font-medium">{batch.reference}</td>
                  <td>{batch.trainingCentre.name}</td>
                  <td>
                    <StatusPill status={batch.status} />
                  </td>
                  <td>{formatDate(batch.submittedAt)}</td>
                  <td>
                    <Link className="text-sm font-medium text-blue-700 hover:underline" to={`/batch/${batch.id}`}>
                      Open
                    </Link>
                  </td>
                </tr>
              ))}
              {!other.length && (
                <tr>
                  <td colSpan={5} className="py-4 text-center text-sm text-slate-500">
                    Nothing else yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
