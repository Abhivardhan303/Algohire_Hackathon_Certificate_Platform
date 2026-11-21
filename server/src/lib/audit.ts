import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from './prisma';

type Db = PrismaClient | Prisma.TransactionClient;

export interface AuditInput {
  actorId?: string | null;
  action: string;
  entityType: string;
  entityId: string;
  metadata?: Prisma.InputJsonValue;
}

/** Append-only audit trail. Never throws into the business flow for metadata issues. */
export async function recordAudit(db: Db, input: AuditInput) {
  await db.auditLog.create({
    data: {
      actorId: input.actorId ?? null,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      metadata: input.metadata,
    },
  });
}

export async function recordAuditSafe(input: AuditInput) {
  try {
    await recordAudit(prisma, input);
  } catch (error) {
    console.error('[audit] failed to record', input.action, error);
  }
}
