import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requireRole } from '../auth/middleware';
import { asyncHandler, badRequest, notFound } from '../lib/errors';
import { prisma } from '../lib/prisma';
import { revokeCertificate } from '../services/verificationService';

const router = Router();
router.use(authenticate);

router.get(
  '/:id/pdf',
  asyncHandler(async (req, res) => {
    const certificate = await prisma.certificate.findUnique({
      where: { id: req.params.id },
      include: { candidate: true, batch: true },
    });
    if (!certificate) throw notFound('Certificate not found');

    const user = req.authUser!;
    const allowed =
      user.role === 'STATE_OFFICE' ||
      user.role === 'QUALITY_TEAM' ||
      (user.role === 'TRAINING_CENTRE' && certificate.batch.trainingCentreId === user.trainingCentreId) ||
      (user.role === 'DISTRICT_OFFICER' && certificate.batch.district === user.district);
    if (!allowed) throw notFound('Certificate not found');
    if (!certificate.pdfPath) throw notFound('Certificate PDF has not been generated yet');

    const absolute = path.resolve(process.cwd(), certificate.pdfPath);
    if (!fs.existsSync(absolute)) throw notFound('Certificate PDF file is missing on disk');

    res.setHeader('Content-Type', 'application/pdf');
    res.sendFile(absolute);
  }),
);

router.post(
  '/:id/revoke',
  requireRole('STATE_OFFICE'),
  asyncHandler(async (req, res) => {
    const parsed = z.object({ reason: z.string().min(3).max(500) }).safeParse(req.body);
    if (!parsed.success) throw badRequest('A revocation reason (min 3 characters) is required');
    const certificate = await revokeCertificate(req.authUser!, req.params.id, parsed.data.reason);
    res.json({ certificate });
  }),
);

export default router;
