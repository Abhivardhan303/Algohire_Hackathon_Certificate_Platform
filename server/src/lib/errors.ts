import type { NextFunction, Request, Response } from 'express';

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/** Error that must never be retried by BullMQ / the sync fallback. */
export class NonRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NonRetryableError';
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new HttpError(400, message, 'BAD_REQUEST', details);
export const unauthorized = (message = 'Authentication required') =>
  new HttpError(401, message, 'UNAUTHORIZED');
export const forbidden = (message = 'You are not allowed to perform this action') =>
  new HttpError(403, message, 'FORBIDDEN');
export const notFound = (message = 'Resource not found') =>
  new HttpError(404, message, 'NOT_FOUND');
export const conflict = (message: string, details?: unknown) =>
  new HttpError(409, message, 'CONFLICT', details);

export const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };

export function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002';
}
