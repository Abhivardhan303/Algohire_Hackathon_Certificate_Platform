import type { BatchStatus } from '@prisma/client';
import { conflict } from '../lib/errors';

/**
 * Explicit batch state machine. Every status change in the application goes through
 * `assertTransition` - there is no generic "update batch status" endpoint.
 */
export const TRANSITIONS = {
  SUBMIT: { from: ['DRAFT'] as BatchStatus[], to: 'PENDING_DISTRICT' },
  RESUBMIT: { from: ['RETURNED'] as BatchStatus[], to: 'PENDING_DISTRICT' },
  DISTRICT_APPROVED: { from: ['PENDING_DISTRICT'] as BatchStatus[], to: 'PENDING_STATE' },
  DISTRICT_REJECT: { from: ['PENDING_DISTRICT'] as BatchStatus[], to: 'REJECTED' },
  DISTRICT_RETURN: { from: ['PENDING_DISTRICT'] as BatchStatus[], to: 'RETURNED' },
  STATE_APPROVE: { from: ['PENDING_STATE'] as BatchStatus[], to: 'APPROVED' },
  STATE_REJECT: { from: ['PENDING_STATE'] as BatchStatus[], to: 'REJECTED' },
  STATE_RETURN: { from: ['PENDING_STATE'] as BatchStatus[], to: 'RETURNED' },
  ISSUE_CERTIFICATES: { from: ['APPROVED'] as BatchStatus[], to: 'ISSUED' },
} as const;

export type TransitionName = keyof typeof TRANSITIONS;

export const DISTRICT_APPROVALS_REQUIRED = 2;

export function assertTransition(current: BatchStatus, transition: TransitionName): BatchStatus {
  const rule = TRANSITIONS[transition];
  if (!rule.from.includes(current)) {
    throw conflict(
      `Illegal transition ${transition} from status ${current}. Allowed from: ${rule.from.join(', ')}`,
      { currentStatus: current, transition, allowedFrom: rule.from },
    );
  }
  return rule.to;
}

export function canTransition(current: BatchStatus, transition: TransitionName): boolean {
  return TRANSITIONS[transition].from.includes(current);
}
