export type Role = 'TRAINING_CENTRE' | 'DISTRICT_OFFICER' | 'QUALITY_TEAM' | 'STATE_OFFICE';

export interface DemoUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  district: string | null;
  trainingCentre: { id: string; name: string } | null;
}

export interface Approval {
  id: string;
  officerId: string;
  decision: 'APPROVE' | 'REJECT' | 'RETURN';
  reason: string | null;
  createdAt: string;
  officer: { id: string; name: string; role: Role };
}

export interface ApprovalRound {
  id: string;
  roundNumber: number;
  createdAt: string;
  closedAt: string | null;
  approvals: Approval[];
}

export interface Candidate {
  id: string;
  rowNumber: number;
  name: string;
  identifier: string;
  course: string;
  phone: string;
}

export interface DeliveryJob {
  id: string;
  status: 'PENDING' | 'SENT' | 'FAILED';
  attempts: number;
  lastError: string | null;
  sentAt: string | null;
}

export interface Certificate {
  id: string;
  certificateNumber: string;
  verificationToken: string;
  status: 'VALID' | 'REVOKED';
  issueDate: string;
  pdfPath: string | null;
  revokedAt: string | null;
  revokeReason: string | null;
  candidateId: string;
  deliveryJob: DeliveryJob | null;
}

export interface Batch {
  id: string;
  reference: string;
  district: string;
  course: string;
  status: BatchStatus;
  roundNumber: number;
  submittedAt: string | null;
  issuedAt: string | null;
  rejectionReason: string | null;
  createdAt: string;
  trainingCentre: { id: string; name: string; district: string };
  candidates: Candidate[];
  rounds: ApprovalRound[];
  certificates: Certificate[];
}

export type BatchStatus =
  | 'DRAFT'
  | 'PENDING_DISTRICT'
  | 'PENDING_STATE'
  | 'APPROVED'
  | 'ISSUED'
  | 'RETURNED'
  | 'REJECTED';

export interface UiInfo {
  actions: string[];
  myDecision: string | null;
  districtApprovals: number;
  requiredDistrictApprovals: number;
  currentRoundNumber: number;
}

export interface BatchListItem extends Batch {
  ui: UiInfo;
  candidateCount: number;
}

export interface AuditLog {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  actor: { name: string; role: Role } | null;
}

export interface PublicCertificate {
  certificateNumber: string;
  status: 'VALID' | 'REVOKED' | 'NOT_FOUND';
  candidateName: string;
  candidateIdentifier: string;
  course: string;
  trainingCentre: string;
  district: string;
  issueDate: string;
  revokedAt: string | null;
  revokeReason: string | null;
  verificationToken: string;
  verificationUrl: string;
  pdfUrl: string;
}
