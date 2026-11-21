import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import type { BatchStatus } from '@prisma/client';
import { authenticate, requireRole } from '../auth/middleware';
import type { AuthUser } from '../auth/middleware';
import { asyncHandler, badRequest } from '../lib/errors';
import { prisma } from '../lib/prisma';
import {
  getBatchForUser,
  listBatches,
  resubmitBatch,
  submitBatch,
  uploadBatch,
  type BatchWithRelations,
} from '../services/batchService';
import { recordDistrictDecision, recordStateDecision } from '../services/approvalService';
import { issueCertificatesForBatch } from '../services/certificateService';
import { enqueueCertificateIssuance } from '../queue/dispatch';
import { revokeBatchCertificates } from '../services/verificationService';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

const decisions = ['APPROVE', 'REJECT', 'RETURN'] as const;

function availableActions(user: AuthUser, batch: BatchWithRelations) {
  const currentRound = batch.rounds.find((round) => round.roundNumber === batch.roundNumber);
  const myDecision = currentRound?.approvals.find((approval) => approval.officerId === user.id)?.decision ?? null;
  const districtApprovals = currentRound?.approvals.filter((a) => a.decision === 'APPROVE').length ?? 0;
  const actions: string[] = [];

  if (user.role === 'TRAINING_CENTRE' && batch.trainingCentreId === user.trainingCentreId) {
    if (batch.status === 'DRAFT') actions.push('SUBMIT');
    if (batch.status === 'RETURNED') actions.push('RESUBMIT');
  }
  if (user.role === 'DISTRICT_OFFICER' && batch.district === user.district && batch.status === 'PENDING_DISTRICT' && !myDecision) {
    actions.push('DISTRICT_DECISION');
  }
  if (user.role === 'STATE_OFFICE' && batch.status === 'PENDING_STATE') actions.push('STATE_DECISION');
  if (user.role === 'STATE_OFFICE' && batch.status === 'APPROVED') actions.push('RETRY_ISSUANCE');
  if (user.role === 'STATE_OFFICE' && (batch.status === 'APPROVED' || batch.status === 'ISSUED')) {
    actions.push('REVOKE_CERTIFICATES');
  }

  return { actions, myDecision, districtApprovals, requiredDistrictApprovals: 2, currentRoundNumber: batch.roundNumber };
}

router.use(authenticate);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const statusParam = typeof req.query.status === 'string' ? req.query.status : undefined;
    const allowedStatuses: BatchStatus[] = [
      'DRAFT',
      'PENDING_DISTRICT',
      'PENDING_STATE',
      'APPROVED',
      'ISSUED',
      'RETURNED',
      'REJECTED',
    ];
    if (statusParam && !allowedStatuses.includes(statusParam as BatchStatus)) {
      throw badRequest(`Unknown status filter: ${statusParam}`);
    }
    const batches = await listBatches(req.authUser!, {
      status: statusParam as BatchStatus | undefined,
      district: typeof req.query.district === 'string' ? req.query.district : undefined,
    });
    res.json({
      batches: batches.map((batch) => ({
        ...batch,
        ui: availableActions(req.authUser!, batch),
        candidateCount: batch.candidates.length,
      })),
    });
  }),
);

router.post(
  '/',
  requireRole('TRAINING_CENTRE'),
  upload.single('file'),
  asyncHandler(async (req, res) => {
    let content: string | Buffer | undefined;
    if (req.file?.buffer) content = req.file.buffer;
    else if (typeof req.body?.csv === 'string' && req.body.csv.trim()) content = req.body.csv;
    if (!content) {
      throw badRequest(
        'Attach a CSV file in the "file" field (or send { "csv": "..." }). Excel .xlsx is not supported - export to CSV first.',
      );
    }
    const result = await uploadBatch(req.authUser!, content);
    res.status(201).json(result);
  }),
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const batch = await getBatchForUser(req.authUser!, req.params.id);
    const certificateIds = batch.certificates.map((c) => c.id);
    const deliveryIds = batch.certificates.map((c) => c.deliveryJob?.id).filter((id): id is string => Boolean(id));

    const auditLogs = await prisma.auditLog.findMany({
      where: {
        OR: [
          { entityType: 'Batch', entityId: batch.id },
          { entityType: 'Certificate', entityId: { in: certificateIds } },
          { entityType: 'DeliveryJob', entityId: { in: deliveryIds } },
        ],
      },
      orderBy: { createdAt: 'asc' },
      include: { actor: { select: { name: true, role: true } } },
    });

    res.json({ batch, ui: availableActions(req.authUser!, batch), auditLogs });
  }),
);

router.post(
  '/:id/submit',
  requireRole('TRAINING_CENTRE'),
  asyncHandler(async (req, res) => {
    const batch = await submitBatch(req.authUser!, req.params.id);
    res.json({ batch });
  }),
);

router.post(
  '/:id/resubmit',
  requireRole('TRAINING_CENTRE'),
  asyncHandler(async (req, res) => {
    const batch = await resubmitBatch(req.authUser!, req.params.id);
    res.json({ batch });
  }),
);

router.post(
  '/:id/decisions',
  requireRole('DISTRICT_OFFICER'),
  asyncHandler(async (req, res) => {
    const parsed = z
      .object({ decision: z.enum(decisions), reason: z.string().max(500).optional() })
      .safeParse(req.body);
    if (!parsed.success) throw badRequest('decision must be APPROVE, REJECT or RETURN', parsed.error.issues);

    const result = await recordDistrictDecision(req.authUser!, {
      batchId: req.params.id,
      decision: parsed.data.decision,
      reason: parsed.data.reason,
    });
    res.json(result);
  }),
);

router.post(
  '/:id/state-decision',
  requireRole('STATE_OFFICE'),
  asyncHandler(async (req, res) => {
    const parsed = z
      .object({ decision: z.enum(decisions), reason: z.string().max(500).optional() })
      .safeParse(req.body);
    if (!parsed.success) throw badRequest('decision must be APPROVE, REJECT or RETURN', parsed.error.issues);

    const result = await recordStateDecision(req.authUser!, {
      batchId: req.params.id,
      decision: parsed.data.decision,
      reason: parsed.data.reason,
    });

    let queueMode: string | null = null;
    if (result.shouldIssue) {
      // State approval is already committed. Issuance is only *requested* here.
      const modeInfo = await enqueueCertificateIssuance(req.params.id);
      queueMode = modeInfo.mode;
    }

    res.json({ ...result, queueMode });
  }),
);

router.post(
  '/:id/issue',
  requireRole('STATE_OFFICE'),
  asyncHandler(async (req, res) => {
    const batch = await getBatchForUser(req.authUser!, req.params.id);
    if (batch.status === 'APPROVED') {
      const modeInfo = await enqueueCertificateIssuance(batch.id);
      return res.json({ queued: true, queueMode: modeInfo.mode });
    }
    if (batch.status === 'ISSUED') {
      const summary = await issueCertificatesForBatch(batch.id);
      return res.json({ queued: false, summary });
    }
    throw badRequest(`Batch cannot be issued from status ${batch.status}`);
  }),
);

router.post(
  '/:id/revoke-certificates',
  requireRole('STATE_OFFICE'),
  asyncHandler(async (req, res) => {
    const parsed = z.object({ reason: z.string().min(3).max(500) }).safeParse(req.body);
    if (!parsed.success) throw badRequest('A revocation reason (min 3 characters) is required');
    const result = await revokeBatchCertificates(req.authUser!, req.params.id, parsed.data.reason);
    res.json(result);
  }),
);

router.get(
  '/:id/audit',
  asyncHandler(async (req, res) => {
    const batch = await getBatchForUser(req.authUser!, req.params.id);
    const logs = await prisma.auditLog.findMany({
      where: { entityType: 'Batch', entityId: batch.id },
      orderBy: { createdAt: 'asc' },
      include: { actor: { select: { name: true, role: true } } },
    });
    res.json({ logs });
  }),
);

export default router;
