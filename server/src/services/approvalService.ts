import type { ApprovalDecision, BatchStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { badRequest, conflict, forbidden, isUniqueViolation, notFound } from '../lib/errors';
import { recordAudit } from '../lib/audit';
import { assertTransition, DISTRICT_APPROVALS_REQUIRED } from './stateMachine';
import type { AuthUser } from '../auth/middleware';

export interface DecisionInput {
  batchId: string;
  decision: ApprovalDecision;
  reason?: string;
}

function requireReason(decision: ApprovalDecision, reason?: string) {
  if (decision !== 'APPROVE' && (!reason || !reason.trim())) {
    throw badRequest('A reason is required when rejecting or returning a batch');
  }
}

/**
 * District approval. The batch row is locked FOR UPDATE so two simultaneous approvals
 * are serialised: the second one re-reads the latest status and the approval count,
 * therefore the batch can only advance to PENDING_STATE once.
 */
export async function recordDistrictDecision(user: AuthUser, input: DecisionInput) {
  if (user.role !== 'DISTRICT_OFFICER') throw forbidden('Only district officers can record district decisions');
  requireReason(input.decision, input.reason);

  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: string; status: BatchStatus; district: string; roundNumber: number }>>`
      SELECT id, status, district, "roundNumber" FROM "Batch" WHERE id = ${input.batchId} FOR UPDATE`;
    const row = locked[0];
    if (!row) throw notFound('Batch not found');
    if (row.district !== user.district) throw forbidden('This batch belongs to another district');
    if (row.status !== 'PENDING_DISTRICT') {
      throw conflict(
        `Batch cannot be approved in its current state (${row.status}). It must be PENDING_DISTRICT.`,
        { currentStatus: row.status },
      );
    }

    const round = await tx.approvalRound.findUnique({
      where: { batchId_roundNumber: { batchId: row.id, roundNumber: row.roundNumber } },
    });
    if (!round || round.closedAt) throw conflict('There is no open approval round for this batch');

    if (input.decision !== 'APPROVE') {
      const nextStatus = assertTransition(row.status, input.decision === 'REJECT' ? 'DISTRICT_REJECT' : 'DISTRICT_RETURN');
      await tx.approval.create({
        data: { roundId: round.id, officerId: user.id, decision: input.decision, reason: input.reason },
      });
      await tx.approvalRound.update({ where: { id: round.id }, data: { closedAt: new Date() } });
      const updated = await tx.batch.update({
        where: { id: row.id },
        data: { status: nextStatus, rejectionReason: input.reason },
      });
      await recordAudit(tx, {
        actorId: user.id,
        action: input.decision === 'REJECT' ? 'BATCH_REJECTED_BY_DISTRICT' : 'BATCH_RETURNED_BY_DISTRICT',
        entityType: 'Batch',
        entityId: row.id,
        metadata: { roundNumber: row.roundNumber, reason: input.reason },
      });
      return {
        batch: updated,
        approvals: 1,
        required: DISTRICT_APPROVALS_REQUIRED,
        advancedToState: false,
        message: input.decision === 'REJECT' ? 'Batch rejected' : 'Batch returned to training centre',
      };
    }

    let approvalId: string;
    try {
      const approval = await tx.approval.create({
        data: { roundId: round.id, officerId: user.id, decision: 'APPROVE' },
      });
      approvalId = approval.id;
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw conflict('You have already recorded a decision for this approval round');
      }
      throw error;
    }

    const approveCount = await tx.approval.count({ where: { roundId: round.id, decision: 'APPROVE' } });

    if (approveCount >= DISTRICT_APPROVALS_REQUIRED) {
      const nextStatus = assertTransition(row.status, 'DISTRICT_APPROVED');
      await tx.approvalRound.update({ where: { id: round.id }, data: { closedAt: new Date() } });
      const updated = await tx.batch.update({ where: { id: row.id }, data: { status: nextStatus } });
      await recordAudit(tx, {
        actorId: user.id,
        action: 'BATCH_DISTRICT_APPROVED',
        entityType: 'Batch',
        entityId: row.id,
        metadata: { roundNumber: row.roundNumber, approvals: approveCount, approvalId },
      });
      return {
        batch: updated,
        approvals: approveCount,
        required: DISTRICT_APPROVALS_REQUIRED,
        advancedToState: true,
        message: 'Second district approval recorded - batch forwarded to state office',
      };
    }

    await recordAudit(tx, {
      actorId: user.id,
      action: 'BATCH_DISTRICT_APPROVAL_RECORDED',
      entityType: 'Batch',
      entityId: row.id,
      metadata: { roundNumber: row.roundNumber, approvals: approveCount, approvalId },
    });
    return {
      batch: row,
      approvals: approveCount,
      required: DISTRICT_APPROVALS_REQUIRED,
      advancedToState: false,
      message: `Approval recorded (${approveCount}/${DISTRICT_APPROVALS_REQUIRED})`,
    };
  });
}

/**
 * State office decision. State approval is committed BEFORE certificate issuance is
 * requested, so a queue failure can never leave an approved batch without a way to
 * retry issuance.
 */
export async function recordStateDecision(user: AuthUser, input: DecisionInput) {
  if (user.role !== 'STATE_OFFICE') throw forbidden('Only the state office can record a final decision');
  requireReason(input.decision, input.reason);

  const result = await prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: string; status: BatchStatus; roundNumber: number }>>`
      SELECT id, status, "roundNumber" FROM "Batch" WHERE id = ${input.batchId} FOR UPDATE`;
    const row = locked[0];
    if (!row) throw notFound('Batch not found');
    if (row.status !== 'PENDING_STATE') {
      throw conflict(`Batch cannot receive a state decision in status ${row.status}`, { currentStatus: row.status });
    }

    if (input.decision !== 'APPROVE') {
      const nextStatus = assertTransition(row.status, input.decision === 'REJECT' ? 'STATE_REJECT' : 'STATE_RETURN');
      const updated = await tx.batch.update({
        where: { id: row.id },
        data: { status: nextStatus, rejectionReason: input.reason },
      });
      await recordAudit(tx, {
        actorId: user.id,
        action: input.decision === 'REJECT' ? 'BATCH_REJECTED_BY_STATE' : 'BATCH_RETURNED_BY_STATE',
        entityType: 'Batch',
        entityId: row.id,
        metadata: { reason: input.reason, roundNumber: row.roundNumber },
      });
      return { updated, shouldIssue: false, message: input.decision === 'REJECT' ? 'Batch rejected' : 'Batch returned' };
    }

    const nextStatus = assertTransition(row.status, 'STATE_APPROVE');
    const updated = await tx.batch.update({ where: { id: row.id }, data: { status: nextStatus } });
    await recordAudit(tx, {
      actorId: user.id,
      action: 'BATCH_APPROVED_BY_STATE',
      entityType: 'Batch',
      entityId: row.id,
      metadata: { roundNumber: row.roundNumber },
    });
    return { updated, shouldIssue: true, message: 'Final approval recorded, certificate issuance requested' };
  });

  return result;
}
