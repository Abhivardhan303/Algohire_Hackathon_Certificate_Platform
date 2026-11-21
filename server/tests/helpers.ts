import fs from 'node:fs';
import path from 'node:path';
import type { BatchStatus } from '@prisma/client';
import { prisma } from '../src/lib/prisma';
import { signToken } from '../src/auth/middleware';
import { env } from '../src/config/env';

export interface SeedIds {
  puneCentreId: string;
  nagpurCentreId: string;
  anikaId: string;
  devId: string;
  meeraId: string;
  kabirId: string;
  nehaId: string;
  farahId: string;
}

export async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE "AuditLog", "DeliveryJob", "Certificate", "Approval", "ApprovalRound", "Candidate", "Batch", "User", "TrainingCentre" RESTART IDENTITY CASCADE',
  );
  const storage = path.resolve(process.cwd(), env.STORAGE_DIR);
  fs.rmSync(storage, { recursive: true, force: true });
}

export async function seedDemoData(): Promise<SeedIds> {
  const pune = await prisma.trainingCentre.create({
    data: { code: 'PUN-C1', name: 'Pune Skills Academy', district: 'Pune' },
  });
  const nagpur = await prisma.trainingCentre.create({
    data: { code: 'NAG-C1', name: 'Nagpur Vocational Institute', district: 'Nagpur' },
  });

  const [anika, dev, meera, kabir, neha, farah] = await Promise.all([
    prisma.user.create({
      data: { name: 'Anika', email: 'anika@certiflow.test', role: 'TRAINING_CENTRE', trainingCentreId: pune.id },
    }),
    prisma.user.create({ data: { name: 'Dev', email: 'dev@certiflow.test', role: 'DISTRICT_OFFICER', district: 'Pune' } }),
    prisma.user.create({ data: { name: 'Meera', email: 'meera@certiflow.test', role: 'DISTRICT_OFFICER', district: 'Pune' } }),
    prisma.user.create({ data: { name: 'Kabir', email: 'kabir@certiflow.test', role: 'DISTRICT_OFFICER', district: 'Nagpur' } }),
    prisma.user.create({ data: { name: 'Neha', email: 'neha@certiflow.test', role: 'QUALITY_TEAM' } }),
    prisma.user.create({ data: { name: 'Farah', email: 'farah@certiflow.test', role: 'STATE_OFFICE' } }),
  ]);

  return {
    puneCentreId: pune.id,
    nagpurCentreId: nagpur.id,
    anikaId: anika.id,
    devId: dev.id,
    meeraId: meera.id,
    kabirId: kabir.id,
    nehaId: neha.id,
    farahId: farah.id,
  };
}

export function auth(userId: string): { Authorization: string } {
  return { Authorization: `Bearer ${signToken({ id: userId, role: 'TRAINING_CENTRE' })}` };
}

// signToken takes a role only for the JWT payload; authorization always re-reads the DB user.
export const bearer = (userId: string) => ({
  Authorization: `Bearer ${signToken({ id: userId, role: 'STATE_OFFICE' })}`,
});

let referenceCounter = 0;

export async function createBatch(options: {
  trainingCentreId: string;
  district?: string;
  status: BatchStatus;
  roundNumber?: number;
  candidates?: Array<{ name: string; identifier: string; phone: string; course?: string }>;
}): Promise<{ batchId: string; candidateIds: string[]; reference: string }> {
  referenceCounter += 1;
  const reference = `CFB-TEST-${Date.now()}-${referenceCounter}`;
  const roundNumber = options.roundNumber ?? (options.status === 'DRAFT' ? 0 : 1);
  const candidates = options.candidates ?? [
    { name: 'Rohan Patil', identifier: `PUN-${referenceCounter}-A`, phone: '+919812345670' },
    { name: 'Sneha Kulkarni', identifier: `PUN-${referenceCounter}-B`, phone: '+919812345670' },
  ];

  const batch = await prisma.batch.create({
    data: {
      reference,
      trainingCentreId: options.trainingCentreId,
      district: options.district ?? 'Pune',
      course: 'CNC Operator',
      status: options.status,
      roundNumber,
      candidates: {
        create: candidates.map((candidate, index) => ({
          rowNumber: index + 2,
          name: candidate.name,
          identifier: candidate.identifier,
          course: candidate.course ?? 'CNC Operator',
          phone: candidate.phone,
        })),
      },
      rounds:
        roundNumber > 0
          ? { create: Array.from({ length: roundNumber }, (_, index) => ({ roundNumber: index + 1 })) }
          : undefined,
    },
    include: { candidates: true },
  });

  return { batchId: batch.id, candidateIds: batch.candidates.map((c) => c.id), reference };
}

export async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs = 10000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const result = await fn();
    if (result) return result as T;
    if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
