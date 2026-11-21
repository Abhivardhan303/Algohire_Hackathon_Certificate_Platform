import { prisma } from '../lib/prisma';
import { conflict, forbidden, notFound } from '../lib/errors';
import { recordAudit } from '../lib/audit';
import { verificationUrl } from './pdf';
import type { AuthUser } from '../auth/middleware';

export interface PublicCertificate {
  certificateNumber: string;
  status: 'VALID' | 'REVOKED' | 'NOT_FOUND';
  candidateName: string;
  candidateIdentifier: string;
  course: string;
  trainingCentre: string;
  district: string;
  issueDate: string;
  revokedAt: string | null;
  revokeReason: string | null;
  verificationToken: string;
  verificationUrl: string;
  pdfUrl: string;
}

const certificateInclude = {
  candidate: true,
  batch: { include: { trainingCentre: true } },
} as const;

type CertificateRow = Awaited<ReturnType<typeof findCertificate>>;

function findCertificate(where: { certificateNumber: string } | { verificationToken: string }) {
  return prisma.certificate.findUnique({
    where: where as never,
    include: certificateInclude,
  });
}

export function toPublicCertificate(certificate: NonNullable<CertificateRow>): PublicCertificate {
  return {
    certificateNumber: certificate.certificateNumber,
    status: certificate.status === 'VALID' ? 'VALID' : 'REVOKED',
    candidateName: certificate.candidate.name,
    candidateIdentifier: certificate.candidate.identifier,
    course: certificate.candidate.course,
    trainingCentre: certificate.batch.trainingCentre.name,
    district: certificate.batch.district,
    issueDate: certificate.issueDate.toISOString(),
    revokedAt: certificate.revokedAt ? certificate.revokedAt.toISOString() : null,
    revokeReason: certificate.revokeReason,
    verificationToken: certificate.verificationToken,
    verificationUrl: verificationUrl(certificate.verificationToken),
    pdfUrl: `/api/verify/token/${certificate.verificationToken}/pdf`,
  };
}

export async function verifyByNumber(certificateNumber: string): Promise<PublicCertificate> {
  const certificate = await findCertificate({ certificateNumber: certificateNumber.trim() });
  if (!certificate) {
    return {
      certificateNumber,
      status: 'NOT_FOUND',
      candidateName: '',
      candidateIdentifier: '',
      course: '',
      trainingCentre: '',
      district: '',
      issueDate: '',
      revokedAt: null,
      revokeReason: null,
      verificationToken: '',
      verificationUrl: '',
      pdfUrl: '',
    };
  }
  return toPublicCertificate(certificate);
}

export async function verifyByToken(token: string): Promise<PublicCertificate> {
  const certificate = await findCertificate({ verificationToken: token.trim() });
  if (!certificate) throw notFound('Verification code not found');
  return toPublicCertificate(certificate);
}

export async function revokeCertificate(user: AuthUser, certificateId: string, reason: string) {
  if (user.role !== 'STATE_OFFICE') throw forbidden('Only the state office can revoke certificates');
  if (!reason?.trim()) throw conflict('A revocation reason is required');

  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: string; status: string; certificateNumber: string }>>`
      SELECT id, status::text AS status, "certificateNumber" FROM "Certificate" WHERE id = ${certificateId} FOR UPDATE`;
    const row = locked[0];
    if (!row) throw notFound('Certificate not found');
    if (row.status === 'REVOKED') throw conflict('Certificate is already revoked');

    const updated = await tx.certificate.update({
      where: { id: row.id },
      data: { status: 'REVOKED', revokedAt: new Date(), revokedById: user.id, revokeReason: reason.trim() },
    });
    await tx.deliveryJob.updateMany({
      where: { certificateId: row.id, status: { not: 'SENT' } },
      data: { status: 'FAILED', lastError: 'Certificate revoked before delivery' },
    });
    await recordAudit(tx, {
      actorId: user.id,
      action: 'CERTIFICATE_REVOKED',
      entityType: 'Certificate',
      entityId: row.id,
      metadata: { certificateNumber: row.certificateNumber, reason: reason.trim() },
    });
    return updated;
  });
}

export async function revokeBatchCertificates(user: AuthUser, batchId: string, reason: string) {
  if (user.role !== 'STATE_OFFICE') throw forbidden('Only the state office can revoke certificates');
  if (!reason?.trim()) throw conflict('A revocation reason is required');

  return prisma.$transaction(async (tx) => {
    const certificates = await tx.certificate.findMany({
      where: { batchId, status: 'VALID' },
      select: { id: true, certificateNumber: true },
    });
    if (!certificates.length) throw conflict('No valid certificates found for this batch');

    for (const certificate of certificates) {
      await tx.certificate.update({
        where: { id: certificate.id },
        data: { status: 'REVOKED', revokedAt: new Date(), revokedById: user.id, revokeReason: reason.trim() },
      });
      await tx.deliveryJob.updateMany({
        where: { certificateId: certificate.id, status: { not: 'SENT' } },
        data: { status: 'FAILED', lastError: 'Certificate revoked before delivery' },
      });
    }

    await tx.auditLog.create({
      data: {
        actorId: user.id,
        action: 'BATCH_CERTIFICATES_REVOKED',
        entityType: 'Batch',
        entityId: batchId,
        metadata: { reason: reason.trim(), certificateIds: certificates.map((c) => c.id) },
      },
    });

    return { revoked: certificates.length };
  });
}
