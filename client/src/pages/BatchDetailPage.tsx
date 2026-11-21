import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, downloadPdf } from '../api';
import { useAuth } from '../auth';
import { ErrorBox, StatusPill, formatDate } from '../ui';
import type { AuditLog, Batch, Certificate, UiInfo } from '../types';

interface DetailResponse {
  batch: Batch;
  ui: UiInfo;
  auditLogs: AuditLog[];
}

const ACTION_LABELS: Record<string, string> = {
  BATCH_UPLOADED: 'Batch uploaded',
  BATCH_SUBMITTED: 'Batch submitted',
  BATCH_RESUBMITTED: 'Batch resubmitted',
  BATCH_DISTRICT_APPROVAL_RECORDED: 'District approval recorded',
  BATCH_DISTRICT_APPROVED: 'District approval complete (2 officers)',
  BATCH_REJECTED_BY_DISTRICT: 'Rejected by district',
  BATCH_RETURNED_BY_DISTRICT: 'Returned by district',
  BATCH_APPROVED_BY_STATE: 'Final approval by state',
  BATCH_REJECTED_BY_STATE: 'Rejected by state',
  BATCH_RETURNED_BY_STATE: 'Returned by state',
  BATCH_CERTIFICATES_ISSUED: 'Certificates issued',
  CERTIFICATE_ISSUED: 'Certificate issued',
  CERTIFICATE_REVOKED: 'Certificate revoked',
  BATCH_CERTIFICATES_REVOKED: 'Batch certificates revoked',
  WHATSAPP_DELIVERED: 'WhatsApp delivered',
  WHATSAPP_DELIVERY_FAILED: 'WhatsApp delivery failed',
};

function DeliveryCell({ certificate }: { certificate: Certificate }) {
  const job = certificate.deliveryJob;
  if (!job) return <span className="text-xs text-slate-400">not queued</span>;
  const styles =
    job.status === 'SENT'
      ? 'bg-emerald-50 text-emerald-700'
      : job.status === 'FAILED'
        ? 'bg-red-50 text-red-700'
        : 'bg-amber-50 text-amber-700';
  return (
    <div className="space-y-1">
      <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ${styles}`}>{job.status}</span>
      <div className="text-xs text-slate-500">attempts: {job.attempts}</div>
      {job.lastError && <div className="max-w-[16rem] text-xs text-red-600">{job.lastError}</div>}
    </div>
  );
}

export default function BatchDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const [data, setData] = useState<DetailResponse | null>(null);
  const [error, setError] = useState<{ message: string; details?: unknown } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await api<DetailResponse>(`/batches/${id}`);
      setData(response);
    } catch (err) {
      setError({ message: (err as Error).message });
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(task: () => Promise<{ message?: string } | unknown>, successMessage: string, refreshDelay = 0) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = (await task()) as { message?: string } | undefined;
      setNotice(result?.message ?? successMessage);
      setReason('');
      await load();
      if (refreshDelay) {
        setTimeout(() => void load(), refreshDelay);
      }
    } catch (err) {
      setError({ message: (err as Error).message, details: (err as { details?: unknown }).details });
    } finally {
      setBusy(false);
    }
  }

  if (!data) {
    return (
      <div className="space-y-4">
        {error && <ErrorBox message={error.message} details={error.details} />}
        {!error && <div className="card text-sm text-slate-500">Loading batch...</div>}
      </div>
    );
  }

  const { batch, ui, auditLogs } = data;
  const can = (action: string) => ui.actions.includes(action);
  const currentRound = batch.rounds.find((round) => round.roundNumber === batch.roundNumber);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-bold">{batch.reference}</h1>
            <StatusPill status={batch.status} />
          </div>
          <p className="mt-1 text-sm text-slate-600">
            {batch.trainingCentre.name} · district {batch.district} · {batch.course}
          </p>
          <p className="text-xs text-slate-500">
            Created {formatDate(batch.createdAt)} · submitted {formatDate(batch.submittedAt)} · approval round{' '}
            {batch.roundNumber}
          </p>
        </div>
        <button className="btn-secondary" onClick={() => void load()} disabled={busy}>
          Refresh
        </button>
      </div>

      {error && <ErrorBox message={error.message} details={error.details} />}
      {notice && <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">{notice}</div>}
      {batch.rejectionReason && (
        <div className="rounded-lg border border-orange-200 bg-orange-50 p-3 text-sm text-orange-800">
          <span className="font-semibold">Reason:</span> {batch.rejectionReason}
        </div>
      )}

      {(can('SUBMIT') ||
        can('RESUBMIT') ||
        can('DISTRICT_DECISION') ||
        can('STATE_DECISION') ||
        can('RETRY_ISSUANCE') ||
        can('REVOKE_CERTIFICATES')) && (
        <div className="card space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Actions</h2>

          {batch.status === 'PENDING_DISTRICT' && (
            <p className="text-sm text-slate-600">
              District approvals: <span className="font-semibold">{ui.districtApprovals}</span> of{' '}
              {ui.requiredDistrictApprovals} required. Two <em>different</em> officers must approve.
              {ui.myDecision && <span className="ml-2 text-slate-500">You already recorded: {ui.myDecision}.</span>}
            </p>
          )}

          {can('SUBMIT') && (
            <button
              className="btn-primary"
              disabled={busy}
              onClick={() => act(() => api(`/batches/${id}/submit`, { method: 'POST' }), 'Batch submitted', 0)}
            >
              Submit batch to district
            </button>
          )}

          {can('RESUBMIT') && (
            <button
              className="btn-primary"
              disabled={busy}
              onClick={() => act(() => api(`/batches/${id}/resubmit`, { method: 'POST' }), 'Batch resubmitted', 0)}
            >
              Resubmit with a new approval round
            </button>
          )}

          {(can('DISTRICT_DECISION') || can('STATE_DECISION')) && (
            <div className="space-y-3">
              <div>
                <label className="label" htmlFor="reason">
                  Reason (required for return / reject)
                </label>
                <textarea
                  id="reason"
                  className="input"
                  rows={2}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  placeholder="e.g. Candidate phone numbers are invalid"
                />
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  className="btn-success"
                  disabled={busy}
                  onClick={() =>
                    act(
                      () =>
                        api(can('DISTRICT_DECISION') ? `/batches/${id}/decisions` : `/batches/${id}/state-decision`, {
                          method: 'POST',
                          body: JSON.stringify({ decision: 'APPROVE', reason }),
                        }),
                      'Decision recorded',
                      1500,
                    )
                  }
                >
                  {can('DISTRICT_DECISION') ? 'Approve (district)' : 'Give final approval'}
                </button>
                <button
                  className="btn-secondary"
                  disabled={busy}
                  onClick={() =>
                    act(
                      () =>
                        api(can('DISTRICT_DECISION') ? `/batches/${id}/decisions` : `/batches/${id}/state-decision`, {
                          method: 'POST',
                          body: JSON.stringify({ decision: 'RETURN', reason }),
                        }),
                      'Batch returned',
                    )
                  }
                >
                  Return for correction
                </button>
                <button
                  className="btn-danger"
                  disabled={busy}
                  onClick={() =>
                    act(
                      () =>
                        api(can('DISTRICT_DECISION') ? `/batches/${id}/decisions` : `/batches/${id}/state-decision`, {
                          method: 'POST',
                          body: JSON.stringify({ decision: 'REJECT', reason }),
                        }),
                      'Batch rejected',
                    )
                  }
                >
                  Reject
                </button>
              </div>
              <p className="text-xs text-slate-500">
                {can('DISTRICT_DECISION')
                  ? 'The batch moves to the state office automatically after the second district approval.'
                  : 'State approval is recorded before certificate issuance is requested.'}
              </p>
            </div>
          )}

          {can('RETRY_ISSUANCE') && (
            <button
              className="btn-primary"
              disabled={busy}
              onClick={() => act(() => api(`/batches/${id}/issue`, { method: 'POST' }), 'Issuance requested', 1500)}
            >
              Request certificate issuance again
            </button>
          )}

          {can('REVOKE_CERTIFICATES') && (
            <div className="rounded-lg border border-red-200 bg-red-50/60 p-3">
              <p className="text-sm font-semibold text-red-800">Revoke certificates</p>
              <p className="mb-2 text-xs text-red-700">
                Verification becomes REVOKED immediately. Pending WhatsApp deliveries are cancelled.
              </p>
              <button
                className="btn-danger"
                disabled={busy || reason.trim().length < 3}
                onClick={() =>
                  act(
                    () =>
                      api(`/batches/${id}/revoke-certificates`, {
                        method: 'POST',
                        body: JSON.stringify({ reason }),
                      }),
                    'Certificates revoked',
                  )
                }
              >
                Revoke all certificates for this batch
              </button>
              {reason.trim().length < 3 && <p className="mt-1 text-xs text-red-600">Enter a reason above first.</p>}
            </div>
          )}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="card">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">Approval history</h2>
          <div className="space-y-3">
            {batch.rounds.map((round) => (
              <div key={round.id} className="rounded-lg border border-slate-200 p-3">
                <div className="flex items-center justify-between text-sm">
                  <span className="font-semibold">Round {round.roundNumber}</span>
                  <span className="text-xs text-slate-500">{round.closedAt ? `closed ${formatDate(round.closedAt)}` : 'open'}</span>
                </div>
                <ul className="mt-2 space-y-1 text-sm">
                  {round.approvals.map((approval) => (
                    <li key={approval.id} className="flex items-start justify-between gap-2">
                      <span>
                        <span className="font-medium">{approval.officer.name}</span>{' '}
                        <span className="text-xs text-slate-500">({approval.officer.role})</span>
                        {approval.reason && <span className="block text-xs text-slate-500">{approval.reason}</span>}
                      </span>
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                          approval.decision === 'APPROVE'
                            ? 'bg-emerald-50 text-emerald-700'
                            : approval.decision === 'RETURN'
                              ? 'bg-orange-50 text-orange-700'
                              : 'bg-red-50 text-red-700'
                        }`}
                      >
                        {approval.decision}
                      </span>
                    </li>
                  ))}
                  {!round.approvals.length && <li className="text-xs text-slate-500">No decisions yet.</li>}
                </ul>
              </div>
            ))}
            {!batch.rounds.length && <p className="text-sm text-slate-500">Not submitted yet.</p>}
            {currentRound && batch.status === 'PENDING_DISTRICT' && (
              <p className="text-xs text-slate-500">
                {ui.districtApprovals}/{ui.requiredDistrictApprovals} district approvals recorded in the current round.
              </p>
            )}
          </div>
        </div>

        <div className="card">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">Candidates</h2>
          <div className="max-h-72 overflow-y-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Row</th>
                  <th>Name</th>
                  <th>Identifier</th>
                  <th>Course</th>
                  <th>Phone</th>
                </tr>
              </thead>
              <tbody>
                {batch.candidates.map((candidate) => (
                  <tr key={candidate.id}>
                    <td>{candidate.rowNumber}</td>
                    <td className="font-medium">{candidate.name}</td>
                    <td>{candidate.identifier}</td>
                    <td>{candidate.course}</td>
                    <td className="text-slate-500">{candidate.phone}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div className="card overflow-x-auto">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">Certificates & delivery</h2>
        <table className="table">
          <thead>
            <tr>
              <th>Certificate no.</th>
              <th>Status</th>
              <th>Issued</th>
              <th>WhatsApp</th>
              <th>PDF</th>
              {user?.role === 'STATE_OFFICE' && <th>Revoke</th>}
            </tr>
          </thead>
          <tbody>
            {batch.certificates.map((certificate) => (
              <tr key={certificate.id}>
                <td className="font-mono text-xs font-medium">{certificate.certificateNumber}</td>
                <td>
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                      certificate.status === 'VALID' ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'
                    }`}
                  >
                    {certificate.status}
                  </span>
                  {certificate.revokeReason && (
                    <div className="mt-1 max-w-[14rem] text-xs text-slate-500">{certificate.revokeReason}</div>
                  )}
                </td>
                <td>{formatDate(certificate.issueDate)}</td>
                <td>
                  <DeliveryCell certificate={certificate} />
                </td>
                <td>
                  {certificate.pdfPath ? (
                    <button
                      className="text-sm font-medium text-blue-700 hover:underline"
                      onClick={() => void downloadPdf(`/api/certificates/${certificate.id}/pdf`, `${certificate.certificateNumber}.pdf`)}
                    >
                      Download
                    </button>
                  ) : (
                    <span className="text-xs text-slate-400">pending</span>
                  )}
                </td>
                {user?.role === 'STATE_OFFICE' && (
                  <td>
                    {certificate.status === 'VALID' && (
                      <button
                        className="text-sm font-medium text-red-700 hover:underline"
                        disabled={busy || reason.trim().length < 3}
                        onClick={() =>
                          act(
                            () =>
                              api(`/certificates/${certificate.id}/revoke`, {
                                method: 'POST',
                                body: JSON.stringify({ reason }),
                              }),
                            'Certificate revoked',
                          )
                        }
                      >
                        Revoke
                      </button>
                    )}
                  </td>
                )}
              </tr>
            ))}
            {!batch.certificates.length && (
              <tr>
                <td colSpan={6} className="py-4 text-center text-sm text-slate-500">
                  Certificates are generated automatically after state approval.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">Audit trail</h2>
        <ol className="space-y-2">
          {auditLogs.map((log) => (
            <li key={log.id} className="flex flex-wrap items-start justify-between gap-2 border-b border-slate-100 pb-2 text-sm">
              <div>
                <span className="font-medium">{ACTION_LABELS[log.action] ?? log.action}</span>
                <span className="ml-2 text-xs text-slate-500">
                  {log.actor ? `${log.actor.name} (${log.actor.role})` : 'system'} · {log.entityType}
                </span>
                {log.metadata && (
                  <div className="mt-0.5 max-w-xl break-words text-xs text-slate-500">{JSON.stringify(log.metadata)}</div>
                )}
              </div>
              <span className="text-xs text-slate-500">{formatDate(log.createdAt)}</span>
            </li>
          ))}
          {!auditLogs.length && <li className="text-sm text-slate-500">No audit entries yet.</li>}
        </ol>
      </div>
    </div>
  );
}
