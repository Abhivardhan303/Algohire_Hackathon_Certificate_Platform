import request from 'supertest';
import { describe, expect, it, beforeEach } from 'vitest';
import { createApp } from '../src/app';
import { prisma } from '../src/lib/prisma';
import { bearer, createBatch, seedDemoData, type SeedIds } from './helpers';

const app = createApp();
let ids: SeedIds;

beforeEach(async () => {
  ids = await seedDemoData();
});

const validCsv = [
  'name,identifier,course,phone',
  'Rohan Patil,PUN-2001,CNC Operator,+919812345670',
  'Sneha Kulkarni,PUN-2002,Welding Technician,919812345671',
].join('\n');

const invalidCsv = [
  'name,identifier,course,phone',
  'Rohan Patil,PUN-3001,CNC Operator,+919812345670',
  'X,PUN-3002,CNC Operator,not-a-phone',
  'Imran Shaikh,PUN-3003,Industrial Electrician,9812345670',
].join('\n');

describe('batch import validation', () => {
  it('rejects the entire import when any row is invalid (no partial save)', async () => {
    const response = await request(app)
      .post('/api/batches')
      .set(bearer(ids.anikaId))
      .send({ csv: invalidCsv });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('BAD_REQUEST');
    expect(response.body.error.details.errors.length).toBeGreaterThanOrEqual(2);

    const batches = await prisma.batch.count();
    const candidates = await prisma.candidate.count();
    expect(batches).toBe(0);
    expect(candidates).toBe(0);
  });

  it('saves a fully valid batch inside one transaction', async () => {
    const response = await request(app).post('/api/batches').set(bearer(ids.anikaId)).send({ csv: validCsv });
    expect(response.status).toBe(201);
    expect(response.body.candidateCount).toBe(2);

    const batch = await prisma.batch.findUnique({ where: { id: response.body.batchId }, include: { candidates: true } });
    expect(batch?.status).toBe('DRAFT');
    expect(batch?.candidates).toHaveLength(2);
  });

  it('rejects duplicate identifiers inside the same file', async () => {
    const duplicateCsv = [
      'name,identifier,course,phone',
      'Rohan Patil,PUN-4001,CNC Operator,+919812345670',
      'Rohan Again,PUN-4001,CNC Operator,+919812345671',
    ].join('\n');
    const response = await request(app).post('/api/batches').set(bearer(ids.anikaId)).send({ csv: duplicateCsv });
    expect(response.status).toBe(400);
    expect(await prisma.batch.count()).toBe(0);
  });
});

describe('district approval reliability', () => {
  it('does not advance twice when two officers approve simultaneously', async () => {
    const { batchId } = await createBatch({ trainingCentreId: ids.puneCentreId, status: 'PENDING_DISTRICT' });

    const [devResponse, meeraResponse] = await Promise.all([
      request(app).post(`/api/batches/${batchId}/decisions`).set(bearer(ids.devId)).send({ decision: 'APPROVE' }),
      request(app).post(`/api/batches/${batchId}/decisions`).set(bearer(ids.meeraId)).send({ decision: 'APPROVE' }),
    ]);

    expect(devResponse.status).toBe(200);
    expect(meeraResponse.status).toBe(200);

    const batch = await prisma.batch.findUniqueOrThrow({ where: { id: batchId } });
    const approvals = await prisma.approval.count({
      where: { round: { batchId }, decision: 'APPROVE' },
    });
    const rounds = await prisma.approvalRound.count({ where: { batchId } });

    expect(batch.status).toBe('PENDING_STATE');
    expect(approvals).toBe(2);
    expect(rounds).toBe(1);
  });

  it('refuses a second approval from the same officer', async () => {
    const { batchId } = await createBatch({ trainingCentreId: ids.puneCentreId, status: 'PENDING_DISTRICT' });

    const first = await request(app)
      .post(`/api/batches/${batchId}/decisions`)
      .set(bearer(ids.devId))
      .send({ decision: 'APPROVE' });
    const second = await request(app)
      .post(`/api/batches/${batchId}/decisions`)
      .set(bearer(ids.devId))
      .send({ decision: 'APPROVE' });

    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    expect(await prisma.approval.count()).toBe(1);

    const batch = await prisma.batch.findUniqueOrThrow({ where: { id: batchId } });
    expect(batch.status).toBe('PENDING_DISTRICT');
  });

  it('blocks officers from other districts and non-district roles', async () => {
    const { batchId } = await createBatch({ trainingCentreId: ids.puneCentreId, status: 'PENDING_DISTRICT' });

    const otherDistrict = await request(app)
      .post(`/api/batches/${batchId}/decisions`)
      .set(bearer(ids.kabirId))
      .send({ decision: 'APPROVE' });
    const wrongRole = await request(app)
      .post(`/api/batches/${batchId}/decisions`)
      .set(bearer(ids.anikaId))
      .send({ decision: 'APPROVE' });
    const qualityTeam = await request(app)
      .post(`/api/batches/${batchId}/state-decision`)
      .set(bearer(ids.nehaId))
      .send({ decision: 'APPROVE' });

    expect(otherDistrict.status).toBe(403);
    expect(wrongRole.status).toBe(403);
    expect(qualityTeam.status).toBe(403);
    expect(await prisma.approval.count()).toBe(0);
  });

  it('requires two distinct officers and returns/rejects with a reason', async () => {
    const { batchId } = await createBatch({ trainingCentreId: ids.puneCentreId, status: 'PENDING_DISTRICT' });

    const withoutReason = await request(app)
      .post(`/api/batches/${batchId}/decisions`)
      .set(bearer(ids.devId))
      .send({ decision: 'RETURN' });
    expect(withoutReason.status).toBe(400);

    const returned = await request(app)
      .post(`/api/batches/${batchId}/decisions`)
      .set(bearer(ids.devId))
      .send({ decision: 'RETURN', reason: 'Fix candidate phone numbers' });
    expect(returned.status).toBe(200);

    const batch = await prisma.batch.findUniqueOrThrow({ where: { id: batchId } });
    expect(batch.status).toBe('RETURNED');
    expect(batch.rejectionReason).toBe('Fix candidate phone numbers');

    const resubmitted = await request(app).post(`/api/batches/${batchId}/resubmit`).set(bearer(ids.anikaId));
    expect(resubmitted.status).toBe(200);
    expect(resubmitted.body.batch.status).toBe('PENDING_DISTRICT');
    expect(resubmitted.body.batch.roundNumber).toBe(2);
  });
});

describe('state approval and issuance', () => {
  it('issues exactly one certificate per candidate after state approval, even when issuance runs twice', async () => {
    const { batchId } = await createBatch({ trainingCentreId: ids.puneCentreId, status: 'PENDING_STATE' });

    const stateApproval = await request(app)
      .post(`/api/batches/${batchId}/state-decision`)
      .set(bearer(ids.farahId))
      .send({ decision: 'APPROVE' });
    expect(stateApproval.status).toBe(200);

    const { issueCertificatesForBatch } = await import('../src/services/certificateService');
    await import('../src/queue/dispatch').then((module) => module.waitForSyncIdle());
    const summary = await issueCertificatesForBatch(batchId);
    expect(summary.created).toBe(0);
    expect(summary.existing).toBe(2);

    const certificates = await prisma.certificate.findMany({ where: { batchId } });
    expect(certificates).toHaveLength(2);
    expect(new Set(certificates.map((c) => c.certificateNumber)).size).toBe(2);
    expect(new Set(certificates.map((c) => c.candidateId)).size).toBe(2);

    const batch = await prisma.batch.findUniqueOrThrow({ where: { id: batchId } });
    expect(batch.status).toBe('ISSUED');
  });

  it('does not create duplicate certificates when delivery fails', async () => {
    const { batchId } = await createBatch({
      trainingCentreId: ids.puneCentreId,
      status: 'PENDING_STATE',
      candidates: [{ name: 'Failure Case', identifier: 'PUN-7777', phone: '+919812345677' }],
    });

    await request(app).post(`/api/batches/${batchId}/state-decision`).set(bearer(ids.farahId)).send({ decision: 'APPROVE' });

    const { issueCertificatesForBatch } = await import('../src/services/certificateService');
    const { waitForSyncIdle } = await import('../src/queue/dispatch');
    await waitForSyncIdle();

    const delivery = await prisma.deliveryJob.findFirstOrThrow({ where: { certificate: { batchId } } });
    expect(delivery.status).toBe('FAILED');

    await issueCertificatesForBatch(batchId);
    await waitForSyncIdle();

    expect(await prisma.certificate.count({ where: { batchId } })).toBe(1);
    expect(await prisma.deliveryJob.count()).toBe(1);
  });
});

describe('public verification', () => {
  it('returns VALID, then REVOKED after the state office revokes, and NOT_FOUND for unknown numbers', async () => {
    const { batchId } = await createBatch({ trainingCentreId: ids.puneCentreId, status: 'PENDING_STATE' });

    await request(app).post(`/api/batches/${batchId}/state-decision`).set(bearer(ids.farahId)).send({ decision: 'APPROVE' });
    const { waitForSyncIdle } = await import('../src/queue/dispatch');
    await waitForSyncIdle();

    const certificate = await prisma.certificate.findFirstOrThrow({ where: { batchId } });

    const before = await request(app).get(`/api/verify/${certificate.certificateNumber}`);
    expect(before.status).toBe(200);
    expect(before.body.result.status).toBe('VALID');
    expect(before.body.result.candidateName).toBeTruthy();
    expect(JSON.stringify(before.body.result)).not.toContain('phone');

    const revoke = await request(app)
      .post(`/api/certificates/${certificate.id}/revoke`)
      .set(bearer(ids.farahId))
      .send({ reason: 'Issued in error' });
    expect(revoke.status).toBe(200);

    const after = await request(app).get(`/api/verify/${certificate.certificateNumber}`);
    expect(after.body.result.status).toBe('REVOKED');
    expect(after.body.result.revokeReason).toBe('Issued in error');

    const missing = await request(app).get('/api/verify/CF-DOES-NOT-EXIST');
    expect(missing.body.result.status).toBe('NOT_FOUND');
  });

  it('does not let non-state roles revoke certificates', async () => {
    const { batchId } = await createBatch({ trainingCentreId: ids.puneCentreId, status: 'PENDING_STATE' });
    await request(app).post(`/api/batches/${batchId}/state-decision`).set(bearer(ids.farahId)).send({ decision: 'APPROVE' });
    const { waitForSyncIdle } = await import('../src/queue/dispatch');
    await waitForSyncIdle();

    const certificate = await prisma.certificate.findFirstOrThrow({ where: { batchId } });
    const response = await request(app)
      .post(`/api/certificates/${certificate.id}/revoke`)
      .set(bearer(ids.anikaId))
      .send({ reason: 'not allowed' });

    expect(response.status).toBe(403);
    const unchanged = await prisma.certificate.findUniqueOrThrow({ where: { id: certificate.id } });
    expect(unchanged.status).toBe('VALID');
  });
});
