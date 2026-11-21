# CertiFlow — Mermaid Diagrams

> All diagrams are derived from the implementation (`server/src/**`, `client/src/**`).
> Related: [FLOW.md](./FLOW.md) for the prose version, [ARCHITECTURE.md](./ARCHITECTURE.md)
> for topology and data model.

---

## 1. End-to-end flow (master diagram)

Covers every role, endpoint, service, queue and storage hop from CSV upload to public
verification, including return/reject/resubmit, the Redis/sync fork, delivery retry and
revocation.

```mermaid
flowchart TD
  TC["Training Centre<br/>Anika (Pune Skills Academy)"]
  DO["District Officers<br/>Dev + Meera (Pune) / Kabir (Nagpur)"]
  SO["State Office<br/>Farah"]
  QT["Quality Team<br/>Neha (read-only)"]
  PUB["Public verifier<br/>no login"]

  TC -->|"CSV upload"| API_UP["POST /api/batches"]
  API_UP --> V{"parseCandidateCsv:<br/>all rows valid?"}
  V -->|"No"| V400["400 BAD_REQUEST<br/>row-level errors<br/>nothing saved"]
  V -->|"Yes"| UP["batchService.uploadBatch<br/>one transaction: Batch DRAFT + Candidates<br/>audit BATCH_UPLOADED"]
  UP --> SUB["POST /:id/submit"]
  SUB --> ST1["stateMachine<br/>DRAFT to PENDING_DISTRICT<br/>ApprovalRound 1"]
  ST1 --> DD{"District decision<br/>same district only"}
  DD -->|"RETURN + reason"| RET["RETURNED"]
  DD -->|"REJECT + reason"| REJ["REJECTED"]
  DD -->|"APPROVE"| CNT{"approval count<br/>for this round"}
  CNT -->|"1 of 2"| DD
  CNT -->|"2 distinct officers"| ST2["PENDING_STATE<br/>round closed<br/>audit BATCH_DISTRICT_APPROVED"]
  RET --> RS["POST /:id/resubmit<br/>new ApprovalRound"]
  RS --> ST1
  ST2 --> SD{"State office decision"}
  SD -->|"RETURN / REJECT + reason"| RET2["RETURNED / REJECTED"]
  SD -->|"APPROVE"| ST3["APPROVED committed<br/>audit BATCH_APPROVED_BY_STATE"]
  ST3 --> K["dispatch.enqueueCertificateIssuance"]
  K --> RM{"Redis reachable?<br/>QUEUE_MODE auto / sync"}
  RM -->|"Yes"| QB["BullMQ queue<br/>certificate-issuance<br/>jobId issue-batch-batchId"]
  RM -->|"No"| SY["sync fallback<br/>same service in-process"]
  QB --> ISS["certificateService.issueCertificatesForBatch"]
  SY --> ISS
  ISS --> C1["per candidate:<br/>Certificate unique candidateId<br/>number CF-batchRef-row<br/>verificationToken random hex"]
  C1 --> C2["pdf.ts / PDFKit<br/>storage/certificates/CF-....pdf"]
  C2 --> C3["DeliveryJob upsert<br/>+ enqueueDelivery"]
  C3 --> DM{"Redis reachable?"}
  DM -->|"Yes"| QD["BullMQ queue<br/>whatsapp-delivery"]
  DM -->|"No"| SY2["sync fallback"]
  QD --> DEL["deliveryService.processDelivery"]
  SY2 --> DEL
  DEL --> RES{"simulated provider result"}
  RES -->|"success"| SENT["DeliveryJob SENT<br/>audit WHATSAPP_DELIVERED"]
  RES -->|"retryable, attempts left"| BACK["PENDING + exponential backoff"]
  BACK --> DEL
  RES -->|"permanent / exhausted"| FAIL["DeliveryJob FAILED<br/>certificate untouched"]
  ISS --> ISSUED["Batch ISSUED + issuedAt<br/>audit BATCH_CERTIFICATES_ISSUED"]
  SENT --> VER["GET /api/verify/:number<br/>or /api/verify/token/:token"]
  ISSUED --> VER
  PUB --> VER
  VER --> VS{"Certificate.status<br/>read live"}
  VS -->|"VALID"| OK["VALID + public PDF link"]
  VS -->|"REVOKED"| RV["REVOKED + revokedAt + reason"]
  VS -->|"unknown number"| NF["NOT_FOUND"]
  SO -->|"revoke + reason"| REV["verificationService.revoke<br/>Certificate REVOKED<br/>pending deliveries FAILED<br/>audit CERTIFICATE_REVOKED"]
  REV --> RV
  QT -.->|"GET /api/batches<br/>no actions"| VER
```

---

## 2. Happy-path sequence (actors and processes)

```mermaid
sequenceDiagram
  autonumber
  actor TC as Training Centre (Anika)
  actor DO as District Officers (Dev, Meera)
  actor SO as State Office (Farah)
  participant API as Express API
  participant DB as PostgreSQL
  participant Q as Redis / BullMQ
  participant CW as Certificate worker
  participant NW as Notification worker
  participant FS as storage/certificates
  actor PUB as Public verifier

  TC->>API: POST /api/batches (CSV file or csv JSON)
  API->>DB: validate all rows -> tx create Batch DRAFT + Candidates + audit
  API-->>TC: 201 batchId, reference, candidateCount

  TC->>API: POST /batches/:id/submit
  API->>DB: FOR UPDATE -> DRAFT to PENDING_DISTRICT -> ApprovalRound 1
  API-->>TC: 200 batch status

  DO->>API: POST /:id/decisions APPROVE (officer A)
  API->>DB: FOR UPDATE -> insert Approval -> count 1 -> audit
  API-->>DO: 200 approvals 1 of 2

  DO->>API: POST /:id/decisions APPROVE (officer B)
  API->>DB: FOR UPDATE -> insert Approval -> count 2 -> PENDING_STATE -> audit
  API-->>DO: 200 advancedToState true

  SO->>API: POST /:id/state-decision APPROVE
  API->>DB: FOR UPDATE -> PENDING_STATE to APPROVED (committed)
  API->>Q: add issue-batch job
  API-->>SO: 200 queueMode bullmq or sync

  Q->>CW: issue-batch job
  CW->>DB: read batch + candidates
  loop each candidate
    CW->>DB: create Certificate (unique) + DeliveryJob
    CW->>FS: write PDF
    CW->>Q: add deliver job
  end
  CW->>DB: batch APPROVED to ISSUED + audit

  Q->>NW: deliver jobs
  NW->>NW: simulate WhatsApp, retry with backoff if transient
  NW->>DB: DeliveryJob SENT or FAILED + audit

  PUB->>API: GET /api/verify/CF-...
  API->>DB: read Certificate + Candidate + Batch
  API-->>PUB: VALID / REVOKED / NOT_FOUND (no phone data)
```

---

## 3. Batch state machine (single source of truth: `services/stateMachine.ts`)

```mermaid
stateDiagram-v2
  [*] --> DRAFT
  DRAFT --> PENDING_DISTRICT: submit
  PENDING_DISTRICT --> PENDING_DISTRICT: 1st approval recorded
  PENDING_DISTRICT --> PENDING_STATE: 2nd distinct approval
  PENDING_DISTRICT --> RETURNED: district return
  PENDING_DISTRICT --> REJECTED: district reject
  RETURNED --> PENDING_DISTRICT: resubmit with new round
  PENDING_STATE --> APPROVED: state approve
  PENDING_STATE --> RETURNED: state return
  PENDING_STATE --> REJECTED: state reject
  APPROVED --> ISSUED: certificates issued
  ISSUED --> [*]
  REJECTED --> [*]
```

Notes:

* There is no generic "set status" endpoint — every arrow is a named business operation that
  calls `assertTransition`.
* `ISSUED` is not terminal: certificates can still be revoked (certificate state changes,
  batch stays `ISSUED`).

---

## 4. Delivery job state machine

```mermaid
stateDiagram-v2
  [*] --> PENDING
  PENDING --> SENT: provider success
  PENDING --> PENDING: retryable failure, attempts less than max (backoff)
  PENDING --> FAILED: permanent failure
  PENDING --> FAILED: attempts exhausted
  PENDING --> FAILED: certificate revoked
  SENT --> [*]
  FAILED --> [*]
```

`attempts` is persisted **before** each provider call, so retries are observable and bounded
by `WHATSAPP_MAX_ATTEMPTS`.

---

## 5. Queue / worker topology

```mermaid
flowchart LR
  API["Express API<br/>producer"] -->|"issue-batch"| R[("Redis<br/>prefix certiflow")]
  API -->|"deliver"| R
  R -->|"queue certificate-issuance"| CW["certificate worker<br/>concurrency 2"]
  R -->|"queue whatsapp-delivery"| NW["notification worker<br/>concurrency 3"]
  CW --> PG[("PostgreSQL<br/>source of truth")]
  NW --> PG
  CW --> FS[("storage/certificates")]
  CW -->|"enqueue delivery"| R
  API --> PG
```

`QUEUE_MODE=sync` (or `auto` with Redis unreachable) removes Redis from the picture: the API
calls `issueCertificatesForBatch` / `processDelivery` directly with the same retry semantics,
and reports `queueMode: "sync"` on `/api/health`.

---

## 6. CSV validation pipeline

```mermaid
flowchart LR
  F["CSV buffer<br/>max 2 MB"] --> P["csv-parse/sync<br/>columns mapping"]
  P --> H{"headers present?<br/>name, identifier, course, phone"}
  H -->|"No"| E1["error row 1 field header"]
  H -->|"Yes"| R["per row: zod + normalisePhone"]
  R --> D{"duplicate identifier<br/>in file?"}
  D -->|"Yes"| E2["error row N field identifier"]
  D -->|"No"| OKR["valid row"]
  R --> E3["error per field<br/>row N"]
  E1 --> OUT["{rows, errors}"]
  E2 --> OUT
  E3 --> OUT
  OKR --> OUT
  OUT --> G{"errors.length > 0?"}
  G -->|"Yes"| STOP["400 - no transaction, nothing saved"]
  G -->|"No"| TX["BEGIN -> Batch + Candidates + audit -> COMMIT"]
```
