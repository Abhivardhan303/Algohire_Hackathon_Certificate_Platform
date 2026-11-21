import fs from 'node:fs';
import path from 'node:path';
import PDFDocument from 'pdfkit';
import type { Batch, Candidate, Certificate, TrainingCentre } from '@prisma/client';
import { env } from '../config/env';

export function verificationUrl(token: string): string {
  return `${env.PUBLIC_BASE_URL.replace(/\/$/, '')}/verify/${token}`;
}

function storageRoot(): string {
  return path.resolve(process.cwd(), env.STORAGE_DIR);
}

function formatDate(date: Date): string {
  return date.toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' });
}

/**
 * Renders a simple, professional certificate PDF into the persistent local storage
 * directory (no Docker, no external service).
 */
export async function renderCertificatePdf(params: {
  certificate: Certificate;
  candidate: Candidate;
  batch: Batch;
  centre: TrainingCentre;
}): Promise<string> {
  const { certificate, candidate, batch, centre } = params;
  const dir = storageRoot();
  await fs.promises.mkdir(dir, { recursive: true });

  const fileName = `${certificate.certificateNumber}.pdf`;
  const filePath = path.join(dir, fileName);

  await new Promise<void>((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 40 });
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);

    const width = doc.page.width;
    const height = doc.page.height;

    doc.rect(24, 24, width - 48, height - 48).lineWidth(2).strokeColor('#1d4ed8').stroke();
    doc.rect(32, 32, width - 64, height - 64).lineWidth(0.8).strokeColor('#93c5fd').stroke();

    doc.fillColor('#1d4ed8').font('Helvetica-Bold').fontSize(13).text('CERTIFLOW', 0, 56, { align: 'center' });
    doc.fillColor('#64748b').font('Helvetica').fontSize(9).text('SKILL CERTIFICATION AUTHORITY', 0, 74, {
      align: 'center',
      characterSpacing: 2,
    });

    doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(30).text('Certificate of Completion', 0, 110, {
      align: 'center',
    });

    doc.fillColor('#475569').font('Helvetica').fontSize(11).text('This certificate is proudly presented to', 0, 162, {
      align: 'center',
    });

    doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(34).text(candidate.name, 0, 186, { align: 'center' });

    doc.fillColor('#475569').font('Helvetica').fontSize(11).text('for successfully completing the course', 0, 236, {
      align: 'center',
    });
    doc.fillColor('#111827').font('Helvetica-Bold').fontSize(18).text(candidate.course, 0, 254, { align: 'center' });

    doc
      .fillColor('#475569')
      .font('Helvetica')
      .fontSize(10)
      .text(`Conducted by ${centre.name}`, 0, 288, { align: 'center' });

    doc.moveTo(width / 2 - 180, 320).lineTo(width / 2 + 180, 320).lineWidth(0.8).strokeColor('#cbd5e1').stroke();

    const colY = 340;
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#64748b').text('CERTIFICATE NO.', width / 2 - 330, colY, { width: 200 });
    doc.font('Helvetica').fontSize(11).fillColor('#0f172a').text(certificate.certificateNumber, width / 2 - 330, colY + 14, { width: 200 });

    doc.font('Helvetica-Bold').fontSize(9).fillColor('#64748b').text('ISSUE DATE', width / 2 - 100, colY, { width: 200 });
    doc.font('Helvetica').fontSize(11).fillColor('#0f172a').text(formatDate(certificate.issueDate), width / 2 - 100, colY + 14, { width: 200 });

    doc.font('Helvetica-Bold').fontSize(9).fillColor('#64748b').text('CANDIDATE ID', width / 2 + 130, colY, { width: 220 });
    doc.font('Helvetica').fontSize(11).fillColor('#0f172a').text(candidate.identifier, width / 2 + 130, colY + 14, { width: 220 });

    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor('#64748b')
      .text(`Verify at: ${verificationUrl(certificate.verificationToken)}`, 0, height - 88, { align: 'center' });
    doc
      .fontSize(7.5)
      .fillColor('#94a3b8')
      .text(
        `Batch ${batch.reference}  |  Verification code ${certificate.verificationToken.slice(0, 12).toUpperCase()}`,
        0,
        height - 74,
        { align: 'center' },
      );

    doc.end();
    stream.on('finish', () => resolve());
    stream.on('error', reject);
    doc.on('error', reject);
  });

  return path.join(env.STORAGE_DIR.replace(/\\/g, '/'), fileName);
}
