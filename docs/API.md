# CertiFlow — HTTP API Reference

Base URL in development: `http://localhost:4000/api` (Vite proxies `/api` from 5173).

All authenticated endpoints require:

```http
Authorization: Bearer <jwt from POST /auth/demo-login>
```

Standard error envelope:

```json
{ "error": { "message": "Human readable", "code": "FORBIDDEN", "details": null } }
```

`details` carries structured context, e.g. CSV row errors or `{ currentStatus }`.

---

## Health

### `GET /api/health`

Public. Returns 200 when the database is reachable, 503 otherwise.

```json
{
  "status": "ok",
  "database": "up",
  "redis": "up",
  "queueMode": "bullmq",
  "queueReason": "BullMQ via Redis eminent-tomcat-210552.upstash.io:6379 (21ms)",
  "whatsappMode": "mixed"
}
```

`redis: "down"` includes `redisError`. `queueMode` is `bullmq` or `sync` (after the first
resolution) or `unresolved` before it.

---

## Authentication (demo)

### `GET /api/auth/demo-users`

Public.

```json
{
  "users": [
    { "id": "cmp…", "name": "Anika", "email": "anika@certiflow.test", "role": "TRAINING_CENTRE",
      "district": null, "trainingCentre": { "id": "cmp…", "name": "Pune Skills Academy" } }
  ]
}
```

### `POST /api/auth/demo-login`

Public. Body `{ "userId": "cmp…" }`.

```json
{ "token": "eyJ…", "user": { "id": "cmp…", "name": "Anika", "role": "TRAINING_CENTRE", "district": null, "trainingCentre": { "id": "cmp…", "name": "Pune Skills Academy" } } }
```

Errors: `400` missing `userId`, `401` unknown user.

### `GET /api/auth/me`

Authenticated. Returns `{ user: { id, name, email, role, district, trainingCentreId } }`.

---

## Batches

### `GET /api/batches?status=PENDING_DISTRICT&district=Pune`

Authenticated. Results are scoped by role:

| Role | Visible |
| --- | --- |
| `TRAINING_CENTRE` | own training centre only |
| `DISTRICT_OFFICER` | own district, `DRAFT` excluded |
| `STATE_OFFICE` | `PENDING_STATE`, `APPROVED`, `ISSUED`, `RETURNED`, `REJECTED` |
| `QUALITY_TEAM` | everything except `DRAFT` |

`status` must be a valid `BatchStatus` (`400` otherwise). `district` is only honoured for
state/quality.

Response:

```json
{
  "batches": [
    {
      "id": "cmp…", "reference": "CFB-261121-RVER", "district": "Pune",
      "course": "CNC Operator", "status": "PENDING_DISTRICT", "roundNumber": 1,
      "submittedAt": "2026-11-21T05:20:00.000Z", "issuedAt": null, "rejectionReason": null,
      "createdAt": "2026-11-21T05:19:00.000Z",
      "trainingCentre": { "id": "…", "name": "Pune Skills Academy", "district": "Pune" },
      "candidates": [ { "id": "…", "rowNumber": 2, "name": "Rohan Patil", "identifier": "PUN-1001", "course": "CNC Operator", "phone": "+919812340000" } ],
      "rounds": [ { "id": "…", "roundNumber": 1, "createdAt": "…", "closedAt": null,
                    "approvals": [ { "id": "…", "officerId": "…", "decision": "APPROVE", "reason": null,
                                     "createdAt": "…", "officer": { "id": "…", "name": "Dev", "role": "DISTRICT_OFFICER" } } ] } ],
      "certificates": [],
      "candidateCount": 3,
      "ui": { "actions": ["DISTRICT_DECISION"], "myDecision": null, "districtApprovals": 1,
              "requiredDistrictApprovals": 2, "currentRoundNumber": 1 }
    }
  ]
}
```

### `POST /api/batches`

Role: `TRAINING_CENTRE`.

Either `multipart/form-data` with field `file` (CSV, max 2 MB) or
`application/json` with `{ "csv": "name,identifier,course,phone\n…" }`.

**201**

```json
{ "batchId": "cmp…", "reference": "CFB-261121-RVER", "candidateCount": 3 }
```

**400** — any invalid row rejects the entire import (nothing is saved):

```json
{
  "error": {
    "message": "Candidate import rejected: fix all row errors and upload again",
    "code": "BAD_REQUEST",
    "details": {
      "errors": [
        { "row": 3, "field": "name", "message": "Candidate name must be at least 2 characters" },
        { "row": 3, "field": "phone", "message": "Phone number must contain 8-15 digits (optional leading +)" }
      ]
    }
  }
}
```

Other errors: `403` account not linked to a centre; `409` duplicate identifier inside the
batch; `400 UPLOAD_ERROR` file > 2 MB.

### `GET /api/batches/:id`

Authenticated and scoped (see `getBatchForUser`). Returns:

```json
{ "batch": { …same shape as list item… }, "ui": { … }, "auditLogs": [ { "id": "…", "action": "BATCH_UPLOADED", "entityType": "Batch", "entityId": "…", "metadata": { … }, "createdAt": "…", "actor": { "name": "Anika", "role": "TRAINING_CENTRE" } } ] }
```

`auditLogs` covers the batch, its certificates and its delivery jobs, oldest first.

### `POST /api/batches/:id/submit`

Role: `TRAINING_CENTRE`, owner only. `DRAFT → PENDING_DISTRICT`, opens a new approval round.

```json
{ "batch": { "id": "…", "status": "PENDING_DISTRICT", "roundNumber": 1, … } }
```

Errors: `403` not owner, `400` no candidates, `409` already submitted,
`404` unknown batch.

### `POST /api/batches/:id/resubmit`

Role: `TRAINING_CENTRE`, owner only. `RETURNED → PENDING_DISTRICT`, `roundNumber + 1`,
clears `rejectionReason`, opens a new round.

### `POST /api/batches/:id/decisions`

Role: `DISTRICT_OFFICER`; officer's district must match the batch.

Body:

```json
{ "decision": "APPROVE" | "REJECT" | "RETURN", "reason": "required for REJECT/RETURN" }
```

First approval:

```json
{ "batch": { "id": "…", "status": "PENDING_DISTRICT", "roundNumber": 1 }, "approvals": 1, "required": 2, "advancedToState": false, "message": "Approval recorded (1/2)" }
```

Second distinct approval:

```json
{ "batch": { "id": "…", "status": "PENDING_STATE" }, "approvals": 2, "required": 2, "advancedToState": true, "message": "Second district approval recorded - batch forwarded to state office" }
```

Return/reject leads to `RETURNED` / `REJECTED` with `null` batch-shaped `batch` row.

Errors: `400` reason missing, `403` wrong role / other district, `409` wrong status,
`409` officer already decided this round, `409` no open round.

### `POST /api/batches/:id/state-decision`

Role: `STATE_OFFICE`. Body `{ decision, reason }` with the same rules.

Approve:

```json
{ "updated": { "id": "…", "status": "APPROVED" }, "shouldIssue": true, "message": "Final approval recorded, certificate issuance requested", "queueMode": "bullmq" }
```

The state decision is committed first; issuance is requested afterwards.
`queueMode` is `bullmq` or `sync`.

Return/reject produces `RETURNED`/`REJECTED` with `shouldIssue: false` and no issuance.

### `POST /api/batches/:id/issue`

Role: `STATE_OFFICE` — retry/re-request issuance.

* `APPROVED` → enqueues a job (or the sync fallback):
  `{ "queued": true, "queueMode": "bullmq" }`
* `ISSUED` → runs issuance synchronously (idempotent) and returns the summary:
  `{ "queued": false, "summary": { "batchId": "…", "created": 0, "existing": 3, "queuedDeliveries": 0 } }`
* other status → `400`.

### `POST /api/batches/:id/revoke-certificates`

Role: `STATE_OFFICE`. Body `{ "reason": "min 3 characters" }`.

```json
{ "revoked": 3 }
```

`409 No valid certificates found for this batch` when nothing is left to revoke.

### `GET /api/batches/:id/audit`

Authenticated/scoped. `{ "logs": [ … ] }` for the batch entity only.

---

## Certificates

### `GET /api/certificates/:id/pdf`

Authenticated and scoped: state office, quality team, the owning training centre, or an
officer of the batch's district. Returns the PDF (`Content-Type: application/pdf`).
`404` when the certificate, its `pdfPath`, or the file on disk is missing.

### `POST /api/certificates/:id/revoke`

Role: `STATE_OFFICE`. Body `{ "reason": "…" }`.

```json
{ "certificate": { "id": "…", "certificateNumber": "CF-…", "status": "REVOKED", "revokedAt": "…", "revokeReason": "…" } }
```

Errors: `400` reason too short, `403` not state office, `404` unknown, `409` already revoked.

---

## Public verification (no authentication)

### `GET /api/verify/:certificateNumber`

Always 200 for a well-formed lookup:

```json
{
  "result": {
    "certificateNumber": "CF-CFB-261121-RVER-002",
    "status": "VALID",
    "candidateName": "Rohan Patil",
    "candidateIdentifier": "PUN-1001",
    "course": "CNC Operator",
    "trainingCentre": "Pune Skills Academy",
    "district": "Pune",
    "issueDate": "2026-11-21T05:20:11.000Z",
    "revokedAt": null,
    "revokeReason": null,
    "verificationToken": "1ad8fea4cc5e38d8408ba2b0392dfcf3",
    "verificationUrl": "http://localhost:5173/verify/1ad8fea4cc5e38d8408ba2b0392dfcf3",
    "pdfUrl": "/api/verify/token/1ad8fea4cc5e38d8408ba2b0392dfcf3/pdf"
  }
}
```

Unknown number → `status: "NOT_FOUND"` with empty string fields (never `null` strings).
After revocation → `status: "REVOKED"` with `revokedAt` and `revokeReason`.
**No phone number or other unnecessary personal data is exposed.**

### `GET /api/verify/token/:token`

Same payload; `404` when the token is unknown.

### `GET /api/verify/token/:token/pdf`

Streams the certificate PDF to anyone holding the token (the URL printed on the PDF).
`404` when unknown or missing on disk.

---

## Status codes used

| Code | When |
| --- | --- |
| 200 | Successful read/action |
| 201 | Batch created |
| 400 | Validation (body, CSV rows, bad status filter, upload size, missing reason) |
| 401 | Missing/invalid/expired token, unknown demo user |
| 403 | Wrong role, other district, other training centre |
| 404 | Unknown id/token, missing PDF, unrouted path |
| 409 | Illegal transition, duplicate approval, already revoked, duplicate identifier |
| 503 | Database unavailable (`DB_UNAVAILABLE`) |
| 500 | Unexpected server error (`INTERNAL`) |
