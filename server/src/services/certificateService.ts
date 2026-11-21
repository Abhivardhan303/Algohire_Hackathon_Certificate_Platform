import crypto from 'node:crypto';
import { prisma } from '../lib/prisma';
import { NonRetryableError, isUniqueViolation } from '../lib/errors';
import { recordAuditSafe } from '../lib/audit';
import { renderCertificatePdf } from './pdf';
import { enqueueDelivery } from '../queue/dispatch';
import type { Batch, Candidate, TrainingCentre } from '@prisma/client';

export interface IssuanceSummary {
  batchId: string;
  created: number;
  existing: number;
  queuedDeliveries: number;
}

function buildCertificateNumber(batch: Batch, candidate: Candidate): string {
  return `CF-${batch.reference}-${String(candidate.rowNumber).padStart(3, '0')}`;
}

/**
 * Idempotent certificate issuance.
 *
 * - `Certificate.candidateId` is UNIQUE, so a repeated job can never create a second
 *   certificate for the same candidate.
 * - `Certificate.certificateNumber` is UNIQUE as a second safety net.
 * - PDF generation and delivery enqueueing are skipped for certificates that already
 *   have a PDF, so retries are cheap and safe.
 */
export async function issueCertificatesForBatch(batchId: string): Promise<IssuanceSummary> {
  const batch = await prisma.batch.findUnique({
    where: { id: batchId },
    include: {
      candidates: { orderBy: { rowNumber: 'asc' } },
      trainingCentre: true,
    },
  });

  if (!batch) throw new NonRetryableError(`Batch ${batchId} does not exist`);
  if (batch.status !== 'APPROVED' && batch.status !== 'ISSUED') {
    throw new NonRetryableError(
      `Batch ${batch.reference} cannot be issued from status ${batch.status} (state approval is required first)`,
    );
  }

  let created = 0;
  let existing = 0;
  let queuedDeliveries = 0;

  for (const candidate of batch.candidates) {
    const certificate = await ensureCertificate(batch, candidate, batch.trainingCentre);
    if (certificate.isNew) created += 1;
    else existing += 1;

    if (certificate.status === 'REVOKED') continue;

    const deliveryJob = await prisma.deliveryJob.upsert({
      where: { certificateId: certificate.id },
      update: {},
      create: { certificateId: certificate.id },
    });

    if (deliveryJob.status !== 'SENT' && deliveryJob.status !== 'FAILED') {
      await enqueueDelivery(deliveryJob.id);
      queuedDeliveries += 1;
    }
  }

  await prisma.batch.updateMany({
    where: { id: batchId, status: 'APPROVED' },
    data: { status: 'ISSUED', issuedAt: new Date() },
  });

  await recordAuditSafe({
    action: 'BATCH_CERTIFICATES_ISSUED',
    entityType: 'Batch',
    entityId: batchId,
    metadata: { created, existing, queuedDeliveries },
  });

  return { batchId, created, existing, queuedDeliveries };
}

async function ensureCertificate(
  batch: Batch,
  candidate: Candidate,
  centre: TrainingCentre,
): Promise<{ id: string; status: 'VALID' | 'REVOKED'; isNew: boolean }> {
  let certificate = await prisma.certificate.findUnique({ where: { candidateId: candidate.id }, include: {} });
  let isNew = false;

  if (!certificate) {
    try {
      certificate = await prisma.certificate.create({
        data: {
          candidateId: candidate.id,
          batchId: batch.id,
          certificateNumber: buildCertificateNumber(batch, candidate),
          verificationToken: crypto.randomBytes(16).toString('hex'),
          issueDate: new Date(),
        },
      });
      isNew = true;
      await recordAuditSafe({
        action: 'CERTIFICATE_ISSUED',
        entityType: 'Certificate',
        entityId: certificate.id,
        metadata: { certificateNumber: certificate.certificateNumber, candidateId: candidate.id, batchId: batch.id },
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const concurrent = await prisma.certificate.findUnique({ where: { candidateId: candidate.id } });
      if (!concurrent) throw error;
      certificate = concurrent;
      isNew = false;
    }
  }

  if (!certificate.pdfPath) {
    try {
      const pdfPath = await renderCertificatePdf({ certificate, candidate, batch, centre });
      certificate = await prisma.certificate.update({ where: { id: certificate.id }, data: { pdfPath } });
    } catch (error) {
      console.error(`[issuance] PDF rendering failed for ${certificate.certificateNumber}`, error);
      throw error;
    }
  }

  return { id: certificate.id, status: certificate.status, isNew };
}
