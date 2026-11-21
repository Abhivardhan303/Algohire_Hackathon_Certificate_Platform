import { env } from '../config/env';
import { prisma } from '../lib/prisma';
import { recordAuditSafe } from '../lib/audit';
import { NonRetryableError } from '../lib/errors';
import { sendWhatsAppMessage, WhatsAppError } from './whatsapp';
import { verificationUrl } from './pdf';

/**
 * Processes one simulated WhatsApp delivery.
 *
 * Retryable failures are re-thrown so BullMQ (or the sync fallback loop) retries with
 * exponential backoff. Permanent failures are recorded as FAILED without throwing.
 * Delivery never creates certificates - it only reads the existing certificate.
 */
export async function processDelivery(deliveryJobId: string): Promise<void> {
  const job = await prisma.deliveryJob.findUnique({
    where: { id: deliveryJobId },
    include: {
      certificate: {
        include: {
          candidate: true,
          batch: { include: { trainingCentre: true } },
        },
      },
    },
  });

  if (!job) throw new NonRetryableError(`Delivery job ${deliveryJobId} not found`);
  if (job.status === 'SENT') return;

  if (job.certificate.status === 'REVOKED') {
    await prisma.deliveryJob.update({
      where: { id: job.id },
      data: { status: 'FAILED', lastError: 'Certificate was revoked before delivery' },
    });
    return;
  }

  const attempt = job.attempts + 1;
  const { certificate } = job;
  const message = [
    `Hello ${certificate.candidate.name},`,
    `your certificate ${certificate.certificateNumber} for ${certificate.candidate.course} is ready.`,
    `Verify: ${verificationUrl(certificate.verificationToken)}`,
  ].join(' ');

  await prisma.deliveryJob.update({ where: { id: job.id }, data: { attempts: attempt } });

  try {
    const providerRef = await sendWhatsAppMessage({
      phone: certificate.candidate.phone,
      message,
      attempt,
    });

    await prisma.deliveryJob.update({
      where: { id: job.id },
      data: { status: 'SENT', sentAt: new Date(), lastError: null, providerRef },
    });
    await recordAuditSafe({
      action: 'WHATSAPP_DELIVERED',
      entityType: 'DeliveryJob',
      entityId: job.id,
      metadata: { certificateId: certificate.id, attempts: attempt, providerRef },
    });
  } catch (error) {
    const retryable = error instanceof WhatsAppError ? error.retryable : true;
    const exhausted = attempt >= env.WHATSAPP_MAX_ATTEMPTS;
    const finalFailure = !retryable || exhausted;
    const messageText = (error as Error).message;

    await prisma.deliveryJob.update({
      where: { id: job.id },
      data: { status: finalFailure ? 'FAILED' : 'PENDING', lastError: messageText },
    });

    await recordAuditSafe({
      action: 'WHATSAPP_DELIVERY_FAILED',
      entityType: 'DeliveryJob',
      entityId: job.id,
      metadata: { certificateId: certificate.id, attempts: attempt, retryable, finalFailure, error: messageText },
    });

    if (!finalFailure) throw error;
  }
}
