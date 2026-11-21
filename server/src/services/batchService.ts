import type { BatchStatus, Prisma, Role } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { badRequest, forbidden, notFound, conflict, isUniqueViolation } from '../lib/errors';
import { recordAudit } from '../lib/audit';
import { parseCandidateCsv } from './csvImport';
import { assertTransition } from './stateMachine';
import type { AuthUser } from '../auth/middleware';

const batchInclude = {
  trainingCentre: true,
  candidates: { orderBy: { rowNumber: 'asc' } },
  rounds: {
    orderBy: { roundNumber: 'asc' },
    include: { approvals: { include: { officer: { select: { id: true, name: true, role: true } } } } },
  },
  certificates: { include: { deliveryJob: true } },
} satisfies Prisma.BatchInclude;

export type BatchWithRelations = Prisma.BatchGetPayload<{ include: typeof batchInclude }>;

function referencePrefix(): string {
  const now = new Date();
  const y = String(now.getFullYear()).slice(2);
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `CFB-${y}${m}${d}`;
}

async function nextReference(): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();
    const reference = `${referencePrefix()}-${suffix}`;
    const existing = await prisma.batch.findUnique({ where: { reference } });
    if (!existing) return reference;
  }
  throw conflict('Could not allocate a unique batch reference, please retry');
}

export function visibleBatchWhere(user: AuthUser): Prisma.BatchWhereInput {
  switch (user.role) {
    case 'TRAINING_CENTRE':
      return { trainingCentreId: user.trainingCentreId ?? '__none__' };
    case 'DISTRICT_OFFICER':
      return { district: user.district ?? '__none__', status: { not: 'DRAFT' } };
    case 'STATE_OFFICE':
      return { status: { in: ['PENDING_STATE', 'APPROVED', 'ISSUED', 'RETURNED', 'REJECTED'] } };
    case 'QUALITY_TEAM':
      return { status: { not: 'DRAFT' } };
    default:
      return { id: '__none__' };
  }
}

export async function listBatches(
  user: AuthUser,
  filters: { status?: BatchStatus; district?: string },
): Promise<BatchWithRelations[]> {
  const where: Prisma.BatchWhereInput = { ...visibleBatchWhere(user) };
  if (filters.status) where.status = filters.status;
  if (filters.district && (user.role === 'STATE_OFFICE' || user.role === 'QUALITY_TEAM')) {
    where.district = filters.district;
  }
  return prisma.batch.findMany({
    where,
    include: batchInclude,
    orderBy: { createdAt: 'desc' },
  });
}

export async function getBatchForUser(user: AuthUser, batchId: string): Promise<BatchWithRelations> {
  const batch = await prisma.batch.findUnique({ where: { id: batchId }, include: batchInclude });
  if (!batch) throw notFound('Batch not found');

  if (user.role === 'TRAINING_CENTRE' && batch.trainingCentreId !== user.trainingCentreId) {
    throw forbidden('Training centres can only access their own batches');
  }
  if (user.role === 'DISTRICT_OFFICER') {
    if (batch.district !== user.district) throw forbidden('This batch belongs to another district');
    if (batch.status === 'DRAFT') throw forbidden('Batch has not been submitted yet');
  }
  if (user.role === 'STATE_OFFICE' && batch.status === 'DRAFT') {
    throw forbidden('Batch has not been submitted yet');
  }
  if (user.role === 'QUALITY_TEAM' && batch.status === 'DRAFT') {
    throw forbidden('Batch has not been submitted yet');
  }
  return batch;
}

export async function uploadBatch(
  user: AuthUser,
  fileContent: string | Buffer,
): Promise<{ batchId: string; reference: string; candidateCount: number }> {
  if (!user.trainingCentreId) throw forbidden('Your account is not linked to a training centre');

  const centre = await prisma.trainingCentre.findUnique({ where: { id: user.trainingCentreId } });
  if (!centre) throw notFound('Training centre not found');

  // Validate every row first - a single invalid row rejects the whole import.
  const { rows, errors } = parseCandidateCsv(fileContent);
  if (errors.length > 0) {
    throw badRequest('Candidate import rejected: fix all row errors and upload again', { errors });
  }
  if (!rows.length) throw badRequest('Candidate import rejected: no valid rows found');

  const courses = [...new Set(rows.map((r) => r.course))];
  const reference = await nextReference();

  try {
    const batch = await prisma.$transaction(async (tx) => {
      const created = await tx.batch.create({
        data: {
          reference,
          trainingCentreId: centre.id,
          district: centre.district,
          course: courses.length === 1 ? courses[0] : 'Mixed courses',
          status: 'DRAFT',
          candidates: {
            create: rows.map((row) => ({
              rowNumber: row.rowNumber,
              name: row.name,
              identifier: row.identifier,
              course: row.course,
              phone: row.phone,
            })),
          },
        },
      });
      await recordAudit(tx, {
        actorId: user.id,
        action: 'BATCH_UPLOADED',
        entityType: 'Batch',
        entityId: created.id,
        metadata: { reference: created.reference, candidates: rows.length },
      });
      return created;
    });

    return { batchId: batch.id, reference: batch.reference, candidateCount: rows.length };
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw conflict('Duplicate candidate identifier found inside the batch');
    }
    throw error;
  }
}

export async function submitBatch(user: AuthUser, batchId: string) {
  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: string; status: BatchStatus; roundNumber: number }>>`
      SELECT id, status, "roundNumber" FROM "Batch" WHERE id = ${batchId} FOR UPDATE`;
    const row = locked[0];
    if (!row) throw notFound('Batch not found');

    const batch = await tx.batch.findUnique({ where: { id: batchId }, include: { candidates: true } });
    if (!batch) throw notFound('Batch not found');
    if (user.role === 'TRAINING_CENTRE' && batch.trainingCentreId !== user.trainingCentreId) {
      throw forbidden('Training centres can only submit their own batches');
    }
    if (!batch.candidates.length) throw badRequest('Cannot submit a batch without candidates');

    const nextStatus = assertTransition(row.status, 'SUBMIT');
    const roundNumber = row.roundNumber + 1;

    await tx.approvalRound.create({ data: { batchId, roundNumber } });
    const updated = await tx.batch.update({
      where: { id: batchId },
      data: { status: nextStatus, roundNumber, submittedById: user.id, submittedAt: new Date() },
    });
    await recordAudit(tx, {
      actorId: user.id,
      action: 'BATCH_SUBMITTED',
      entityType: 'Batch',
      entityId: batchId,
      metadata: { roundNumber, previousStatus: row.status },
    });
    return updated;
  });
}

export async function resubmitBatch(user: AuthUser, batchId: string) {
  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: string; status: BatchStatus; roundNumber: number }>>`
      SELECT id, status, "roundNumber" FROM "Batch" WHERE id = ${batchId} FOR UPDATE`;
    const row = locked[0];
    if (!row) throw notFound('Batch not found');

    const batch = await tx.batch.findUnique({ where: { id: batchId } });
    if (!batch) throw notFound('Batch not found');
    if (user.role === 'TRAINING_CENTRE' && batch.trainingCentreId !== user.trainingCentreId) {
      throw forbidden('Training centres can only resubmit their own batches');
    }

    const nextStatus = assertTransition(row.status, 'RESUBMIT');
    const roundNumber = row.roundNumber + 1;

    await tx.approvalRound.create({ data: { batchId, roundNumber } });
    const updated = await tx.batch.update({
      where: { id: batchId },
      data: {
        status: nextStatus,
        roundNumber,
        submittedById: user.id,
        submittedAt: new Date(),
        rejectionReason: null,
      },
    });
    await recordAudit(tx, {
      actorId: user.id,
      action: 'BATCH_RESUBMITTED',
      entityType: 'Batch',
      entityId: batchId,
      metadata: { roundNumber, previousStatus: row.status },
    });
    return updated;
  });
}
