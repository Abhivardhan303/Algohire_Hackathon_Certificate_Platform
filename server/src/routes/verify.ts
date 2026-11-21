import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { asyncHandler, notFound } from '../lib/errors';
import { prisma } from '../lib/prisma';
import { verifyByNumber, verifyByToken } from '../services/verificationService';

const router = Router();

/** Public: verification by opaque token (this is the URL printed on the PDF). */
router.get(
  '/token/:token',
  asyncHandler(async (req, res) => {
    const certificate = await verifyByToken(req.params.token);
    res.json({ result: certificate });
  }),
);

/** Public: PDF download for the holder of the verification token. */
router.get(
  '/token/:token/pdf',
  asyncHandler(async (req, res) => {
    const certificate = await prisma.certificate.findUnique({ where: { verificationToken: req.params.token } });
    if (!certificate?.pdfPath) throw notFound('Certificate PDF not found');
    const absolute = path.resolve(process.cwd(), certificate.pdfPath);
    if (!fs.existsSync(absolute)) throw notFound('Certificate PDF file is missing on disk');
    res.setHeader('Content-Type', 'application/pdf');
    res.sendFile(absolute);
  }),
);

/** Public: verification by certificate number. */
router.get(
  '/:certificateNumber',
  asyncHandler(async (req, res) => {
    const result = await verifyByNumber(req.params.certificateNumber);
    res.json({ result });
  }),
);

export default router;
