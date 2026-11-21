import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { PublicCertificate } from '../types';

const BADGE: Record<PublicCertificate['status'], string> = {
  VALID: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  REVOKED: 'bg-red-50 text-red-700 border-red-200',
  NOT_FOUND: 'bg-slate-100 text-slate-600 border-slate-200',
};

export default function VerifyPage() {
  const { token } = useParams<{ token?: string }>();
  const [value, setValue] = useState(token ?? '');
  const [result, setResult] = useState<PublicCertificate | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function verify(input: string) {
    const query = input.trim();
    if (!query) {
      setError('Enter a certificate number or verification link.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const isToken = /^[a-f0-9]{32}$/i.test(query);
      const path = isToken ? `/verify/token/${query}` : `/verify/${encodeURIComponent(query)}`;
      const response = await fetch(`/api${path}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error?.message ?? 'Verification failed');
      setResult(data.result as PublicCertificate);
    } catch (err) {
      setError((err as Error).message);
      setResult(null);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    setValue(token ?? '');
    if (token) void verify(token);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <div className="card">
        <h1 className="text-xl font-bold">Public certificate verification</h1>
        <p className="mt-1 text-sm text-slate-600">
          Enter a certificate number (for example <code>CF-CFB-...</code>) or paste the verification link from the
          certificate. No login required.
        </p>
        <form
          className="mt-4 flex flex-wrap gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void verify(value);
          }}
        >
          <input
            className="input flex-1"
            placeholder="Certificate number or verification code"
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
          <button className="btn-primary" type="submit" disabled={busy}>
            {busy ? 'Checking...' : 'Verify'}
          </button>
        </form>
        {error && <p className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      </div>

      {result && (
        <div className="card space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">Verification result</h2>
            <span className={`rounded-full border px-3 py-1 text-sm font-bold ${BADGE[result.status]}`}>{result.status}</span>
          </div>

          {result.status === 'NOT_FOUND' ? (
            <p className="text-sm text-slate-600">
              No certificate with that number was found. Check the number and try again.
            </p>
          ) : (
            <>
              <dl className="grid gap-2 text-sm sm:grid-cols-2">
                <div>
                  <dt className="label">Certificate number</dt>
                  <dd className="font-mono text-xs">{result.certificateNumber}</dd>
                </div>
                <div>
                  <dt className="label">Candidate</dt>
                  <dd className="font-medium">{result.candidateName}</dd>
                </div>
                <div>
                  <dt className="label">Course</dt>
                  <dd>{result.course}</dd>
                </div>
                <div>
                  <dt className="label">Training centre</dt>
                  <dd>{result.trainingCentre}</dd>
                </div>
                <div>
                  <dt className="label">Issue date</dt>
                  <dd>{new Date(result.issueDate).toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' })}</dd>
                </div>
                <div>
                  <dt className="label">Status</dt>
                  <dd className={result.status === 'VALID' ? 'text-emerald-700' : 'text-red-700'}>{result.status}</dd>
                </div>
              </dl>

              {result.status === 'REVOKED' && (
                <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
                  <p className="font-semibold">This certificate has been revoked.</p>
                  {result.revokedAt && <p>Revoked on {new Date(result.revokedAt).toLocaleString('en-GB')}.</p>}
                  {result.revokeReason && <p>Reason: {result.revokeReason}</p>}
                </div>
              )}

              {result.status === 'VALID' && result.pdfUrl && (
                <a className="btn-secondary" href={result.pdfUrl} target="_blank" rel="noreferrer">
                  Download certificate PDF
                </a>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
