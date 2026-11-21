#!/usr/bin/env node
/**
 * End-to-end smoke test against a running API (npm run dev:backend).
 * Exercises: upload -> submit -> 2 district approvals -> state approval ->
 * issuance -> simulated WhatsApp -> public verification -> revocation.
 *
 * Usage: node scripts/smoke-test.mjs [--revoke]
 */
const BASE = process.env.API_URL ?? 'http://127.0.0.1:4000/api';
const REVOKE = process.argv.includes('--revoke');

async function call(path, options = {}) {
  const response = await fetch(`${BASE}${path}`, options);
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`${options.method ?? 'GET'} ${path} -> ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

const json = (body) => ({ 'content-type': 'application/json', ...(body.__token ? { authorization: `Bearer ${body.__token}` } : {}) });

async function loginByName(name) {
  const { users } = await call('/auth/demo-users');
  const user = users.find((candidate) => candidate.name === name);
  if (!user) throw new Error(`Demo user ${name} not found - did you run npm run db:seed?`);
  const { token } = await call('/auth/demo-login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId: user.id }),
  });
  return { token, user };
}

const post = (token, path, body = {}) =>
  call(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });

function step(label) {
  console.log(`\n=== ${label} ===`);
}

async function main() {
  step('Health');
  const health = await call('/health');
  console.log(health);

  const anika = await loginByName('Anika');
  const dev = await loginByName('Dev');
  const meera = await loginByName('Meera');
  const farah = await loginByName('Farah');

  step('Upload candidate batch (CSV rows validated before saving)');
  const suffix = Date.now().toString().slice(-6);
  const csv = [
    'name,identifier,course,phone',
    `Rohan Patil,PUN-${suffix}-1,CNC Operator,+919812340000`,
    `Sneha Kulkarni,PUN-${suffix}-2,Welding Technician,+919812340000`,
    `Imran Shaikh,PUN-${suffix}-3,Industrial Electrician,+919812340000`,
  ].join('\n');
  const upload = await post(anika.token, '/batches', { csv });
  console.log(upload);

  step('Submit batch to district');
  const submitted = await post(anika.token, `/batches/${upload.batchId}/submit`);
  console.log('status:', submitted.batch.status, 'round:', submitted.batch.roundNumber);

  step('District officer Dev approves (1 of 2)');
  const firstApproval = await post(dev.token, `/batches/${upload.batchId}/decisions`, { decision: 'APPROVE' });
  console.log(firstApproval.message, 'status:', firstApproval.batch.status);

  step('District officer Meera approves (2 of 2)');
  const secondApproval = await post(meera.token, `/batches/${upload.batchId}/decisions`, { decision: 'APPROVE' });
  console.log(secondApproval.message, 'status:', secondApproval.batch.status);

  step('State office final approval (issuance requested after commit)');
  const state = await post(farah.token, `/batches/${upload.batchId}/state-decision`, { decision: 'APPROVE' });
  console.log(state.message, 'queueMode:', state.queueMode);

  step('Wait for in-process issuance + simulated WhatsApp delivery');
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const detail = await call(`/batches/${upload.batchId}`, {
    headers: { authorization: `Bearer ${farah.token}` },
  });
  console.log(
    'batch status:',
    detail.batch.status,
    '| certificates:',
    detail.batch.certificates.length,
    '| deliveries:',
    detail.batch.certificates.map((c) => `${c.deliveryJob?.status}(${c.deliveryJob?.attempts})`).join(', '),
  );

  step('Public verification of the first certificate');
  const certificate = detail.batch.certificates[0];
  const verified = await call(`/verify/${encodeURIComponent(certificate.certificateNumber)}`);
  console.log(verified.result.status, '-', verified.result.candidateName, '/', verified.result.course);

  if (REVOKE) {
    step('State office revokes the batch certificates');
    const revoked = await post(farah.token, `/batches/${upload.batchId}/revoke-certificates`, {
      reason: 'Smoke test revocation',
    });
    console.log('revoked:', revoked.revoked);
    const after = await call(`/verify/${encodeURIComponent(certificate.certificateNumber)}`);
    console.log('verification now:', after.result.status);
  }

  console.log('\nSmoke test complete.');
  console.log(`Open http://localhost:5173/verify/${certificate.verificationToken} to check the public page.`);
}

main().catch((error) => {
  console.error('\nSmoke test failed:', error.message);
  process.exit(1);
});
