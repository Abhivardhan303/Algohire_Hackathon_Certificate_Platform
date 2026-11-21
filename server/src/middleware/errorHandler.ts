import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import multer from 'multer';
import { Prisma } from '@prisma/client';
import { HttpError } from '../lib/errors';

export function errorHandler(error: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (error instanceof HttpError) {
    return res.status(error.status).json({
      error: { message: error.message, code: error.code ?? null, details: error.details ?? null },
    });
  }

  if (error instanceof ZodError) {
    return res.status(400).json({
      error: {
        message: 'Validation failed',
        code: 'VALIDATION_ERROR',
        details: error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message })),
      },
    });
  }

  if (error instanceof multer.MulterError) {
    return res.status(400).json({
      error: {
        message: error.code === 'LIMIT_FILE_SIZE' ? 'File is too large (max 2MB)' : error.message,
        code: 'UPLOAD_ERROR',
        details: null,
      },
    });
  }

  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    const status = error.code === 'P2025' ? 404 : 409;
    return res.status(status).json({
      error: {
        message: error.code === 'P2025' ? 'Record not found' : `Database constraint violation (${error.code})`,
        code: error.code,
        details: null,
      },
    });
  }

  if (error instanceof Prisma.PrismaClientInitializationError) {
    console.error('[db] Prisma initialization error:', error.message);
    return res.status(503).json({
      error: {
        message:
          'Cannot reach PostgreSQL. Check DATABASE_URL in server/.env and make sure the PostgreSQL Windows service is running.',
        code: 'DB_UNAVAILABLE',
        details: null,
      },
    });
  }

  console.error('[error]', error);
  return res.status(500).json({
    error: { message: 'Internal server error', code: 'INTERNAL', details: null },
  });
}
