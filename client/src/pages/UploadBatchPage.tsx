import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError } from '../api';
import { ErrorBox } from '../ui';

const SAMPLE_CSV = `name,identifier,course,phone
Rohan Patil,PUN-1001,CNC Operator,+919812345670
Sneha Kulkarni,PUN-1002,Welding Technician,919812345671
Imran Shaikh,PUN-1003,Industrial Electrician,+91 98123 45672
`;

export default function UploadBatchPage() {
  const navigate = useNavigate();
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; details?: unknown } | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!file) {
      setError({ message: 'Choose a CSV file first.' });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.append('file', file);
      const response = await fetch('/api/batches', {
        method: 'POST',
        headers: { Authorization: `Bearer ${localStorage.getItem('certiflow.token')}` },
        body: form,
      });
      const data = await response.json();
      if (!response.ok) {
        throw new ApiError(response.status, data?.error?.message ?? 'Upload failed', data?.error?.details);
      }
      navigate(`/batch/${data.batchId}`);
    } catch (err) {
      setError({ message: (err as Error).message, details: (err as ApiError).details });
    } finally {
      setBusy(false);
    }
  }

  function downloadSample() {
    const blob = new Blob([SAMPLE_CSV], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'candidate-sample.csv';
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <div>
        <h1 className="text-xl font-bold">Upload candidate batch</h1>
        <p className="text-sm text-slate-600">
          CSV with columns: <code>name, identifier, course, phone</code>. Every row is validated before anything is
          saved - if one row is invalid the whole import is rejected (no partial batch).
        </p>
      </div>

      {error && <ErrorBox message={error.message} details={error.details} />}

      <form onSubmit={submit} className="card space-y-4">
        <div>
          <label className="label" htmlFor="file">
            Candidate CSV
          </label>
          <input
            id="file"
            type="file"
            accept=".csv,text/csv"
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            className="input file:mr-3 file:rounded-md file:border-0 file:bg-blue-50 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-blue-700"
          />
          <p className="mt-2 text-xs text-slate-500">
            Excel (.xlsx) is not supported in this MVP - export your sheet as CSV. Phone numbers: 8-15 digits, optional
            leading +. Identifiers must be unique inside the file.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" className="btn-primary" disabled={busy || !file}>
            {busy ? 'Validating and saving...' : 'Upload batch'}
          </button>
          <button type="button" className="btn-secondary" onClick={downloadSample}>
            Download sample CSV
          </button>
        </div>
      </form>

      <div className="card text-sm text-slate-600">
        <p className="font-semibold text-slate-800">What happens next?</p>
        <ol className="mt-2 list-decimal space-y-1 pl-5">
          <li>The batch is created as a draft (inside one PostgreSQL transaction).</li>
          <li>Submit it to your district office.</li>
          <li>Two different district officers must approve it.</li>
          <li>The state office gives final approval and certificates are generated automatically.</li>
        </ol>
      </div>
    </div>
  );
}
