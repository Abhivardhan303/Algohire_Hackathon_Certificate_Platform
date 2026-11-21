import type { BatchStatus, Role } from './types';

export const STATUS_STYLES: Record<BatchStatus, string> = {
  DRAFT: 'bg-slate-100 text-slate-700 border-slate-200',
  PENDING_DISTRICT: 'bg-amber-50 text-amber-700 border-amber-200',
  PENDING_STATE: 'bg-sky-50 text-sky-700 border-sky-200',
  APPROVED: 'bg-indigo-50 text-indigo-700 border-indigo-200',
  ISSUED: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  RETURNED: 'bg-orange-50 text-orange-700 border-orange-200',
  REJECTED: 'bg-red-50 text-red-700 border-red-200',
};

export const STATUS_LABELS: Record<BatchStatus, string> = {
  DRAFT: 'Draft',
  PENDING_DISTRICT: 'Pending district (2 approvals)',
  PENDING_STATE: 'Pending state approval',
  APPROVED: 'Approved - issuing',
  ISSUED: 'Certificates issued',
  RETURNED: 'Returned',
  REJECTED: 'Rejected',
};

export const ROLE_LABELS: Record<Role, string> = {
  TRAINING_CENTRE: 'Training centre',
  DISTRICT_OFFICER: 'District officer',
  QUALITY_TEAM: 'Quality team',
  STATE_OFFICE: 'State office',
};

export function formatDate(value: string | null): string {
  if (!value) return '-';
  return new Date(value).toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function StatusPill({ status }: { status: BatchStatus }) {
  return (
    <span className={`inline-flex rounded-full border px-2.5 py-0.5 text-xs font-semibold ${STATUS_STYLES[status]}`}>
      {STATUS_LABELS[status]}
    </span>
  );
}

export function ErrorBox({ message, details }: { message: string; details?: unknown }) {
  const rows = Array.isArray((details as { errors?: unknown[] })?.errors)
    ? ((details as { errors: Array<{ row: number; field: string; message: string }> }).errors ?? [])
    : [];
  return (
    <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
      <p className="font-semibold">{message}</p>
      {rows.length > 0 && (
        <ul className="mt-2 list-disc space-y-1 pl-5">
          {rows.map((row, index) => (
            <li key={`${row.row}-${row.field}-${index}`}>
              {row.row > 0 ? `Row ${row.row}` : 'File'} - {row.field}: {row.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
