# CertiFlow — Testing Guide & Test Matrix

## How tests run

```powershell
npm run test            # root → npm run test --workspace server → vitest run
npm run check           # tsc --noEmit for server and client
npm run smoke           # end-to-end HTTP walkthrough (requires a running API)
```

### Test infrastructure

| Piece | Behaviour |
| --- | --- |
| `server/vitest.config.ts` | Loads `server/.env`, rewrites the database name to `certiflow_test`, injects `QUEUE_MODE=sync`, `WHATSAPP_MODE=mixed`, `WHATSAPP_MAX_ATTEMPTS=3`, `STORAGE_DIR=./storage-test/certificates`, `JWT_SECRET=test-secret-certiflow`; single forked worker so database truncation cannot race between files |
| `tests/globalSetup.ts` | Runs `prisma migrate deploy` against `TEST_DATABASE_URL` before the suite |
| `tests/setup.ts` | `beforeEach` → `resetDatabase()`; `afterAll` → `prisma.$disconnect()` |
| `tests/helpers.ts` | `resetDatabase()` truncates `AuditLog, DeliveryJob, Certificate, Approval, ApprovalRound, Candidate, Batch, User, TrainingCentre` (restart identity, cascade) and deletes the test storage folder; `seedDemoData()` creates 2 centres + 6 users; `createBatch()` inserts a batch with N candidates and the requested number of approval rounds directly via Prisma; `bearer(userId)` signs a JWT |
| `tests/workflow.test.ts` | 11 integration tests using `supertest(createApp())` — no port binding, real PostgreSQL |

Because the queue mode is `sync`, issuance and delivery run **in-process** through the same
service functions the workers call; tests await `waitForSyncIdle()` before asserting on
certificates/deliveries. This keeps the business logic under test identical to production
while removing Redis from the test dependency set.

`bearer()` deliberately signs a token with an arbitrary role in the payload: the middleware
re-reads the user, so the tests cannot bypass role checks by forging a token — which is
itself part of what is being validated.

---

## Test matrix

### A. Batch import validation (requirement 8 + test case 1)

#### A1 `rejects the entire import when any row is invalid (no partial save)`
* **Input:** CSV with one fully valid row and one row that is both too short (`X`) and has
  an unparseable phone (`not-a-phone`).
* **Flow exercised:** `POST /api/batches` → `requireRole` → multer-free JSON path →
  `uploadBatch` → `parseCandidateCsv` (Zod + phone normaliser) → throws before any
  transaction.
* **Asserts:**
  * HTTP 400, `code = BAD_REQUEST`
  * `details.errors.length >= 2` (the same row reports **both** field problems)
  * `prisma.batch.count() === 0` **and** `prisma.candidate.count() === 0`
* **Proves:** no partial save; validation happens before persistence.

#### A2 `saves a fully valid batch inside one transaction`
* **Input:** two valid rows.
* **Asserts:** 201 with `candidateCount = 2`; batch exists with `status = DRAFT` and exactly
  2 candidates.
* **Proves:** the happy path and the draft starting state.

#### A3 `rejects duplicate identifiers inside the same file`
* **Input:** same `identifier` on two rows.
* **Asserts:** 400; `batch.count() === 0`.
* **Proves:** duplicate detection is part of pre-save validation, not a late DB error.

---

### B. District approval reliability (requirement 9 + test cases 2, 3, 7)

#### B1 `does not advance twice when two officers approve simultaneously`
* **Setup:** batch `PENDING_DISTRICT`, round 1.
* **Action:** `Promise.all([Dev approve, Meera approve])`.
* **Asserts:** both 200; batch `PENDING_STATE`; **2** approvals; **1** approval round.
* **Mechanism:** `SELECT … FOR UPDATE` serialises the transactions; the second re-reads
  `PENDING_DISTRICT` and its own insert makes the count 2 → single promotion.
* **Proves:** simultaneous approvals cannot double-advance the batch.

#### B2 `refuses a second approval from the same officer`
* **Action:** Dev approves twice sequentially.
* **Asserts:** first 200, second **409**; `approval.count() === 1`; batch still
  `PENDING_DISTRICT`.
* **Mechanism:** `Approval @@unique([roundId, officerId])` → Prisma `P2002` → 409.
* **Proves:** test case 3 (one officer cannot approve twice).

#### B3 `blocks officers from other districts and non-district roles`
* **Actions:** Kabir (Nagpur) approves a Pune batch; Anika (centre) calls the decisions
  endpoint; Neha (quality) calls the state endpoint.
* **Asserts:** 403 for all three; `approval.count() === 0`.
* **Proves:** test case 7 (unauthorized users cannot approve) at both middleware and service
  level.

#### B4 `requires two distinct officers and returns/rejects with a reason`
* **Actions:** Dev `RETURN` without reason → 400; with reason → 200 and batch `RETURNED`
  with `rejectionReason` stored; Anika `resubmit` → 200, `PENDING_DISTRICT`, `roundNumber = 2`.
* **Proves:** reason enforcement, returned-batch path, and resubmission opening a **new**
  approval round (old approvals cannot be reused).

---

### C. State approval, issuance, delivery (requirements 10, 11 + test cases 4, 5)

#### C1 `issues exactly one certificate per candidate after state approval, even when issuance runs twice`
* **Setup:** batch `PENDING_STATE`, 2 candidates.
* **Action:** Farah `POST /state-decision {APPROVE}` → sync fallback issues; `waitForSyncIdle()`;
  then `issueCertificatesForBatch(batchId)` a **second** time.
* **Asserts:** second run reports `created: 0, existing: 2`; `certificate.count() === 2`;
  2 distinct certificate numbers; 2 distinct candidate ids; batch `ISSUED`.
* **Mechanism:** `Certificate.candidateId` unique + `findUnique` reuse + `pdfPath` check.
* **Proves:** test case 4 (duplicate issuance does not create duplicate certificates).

#### C2 `does not create duplicate certificates when delivery fails`
* **Setup:** one candidate with phone `+919812345677` (last digit `7` → permanent failure in
  `WHATSAPP_MODE=mixed`).
* **Action:** state approve → `waitForSyncIdle()` → assert failed delivery → run issuance again.
* **Asserts:** `deliveryJob.status === 'FAILED'`; `certificate.count() === 1`;
  `deliveryJob.count() === 1`.
* **Mechanism:** delivery only updates `DeliveryJob`; issuance reuses the certificate and
  skips re-enqueueing a `FAILED` job.
* **Proves:** test case 5 (WhatsApp failure does not create duplicate certificates).

---

### D. Public verification and revocation (requirements 12, 13 + test case 6)

#### D1 `returns VALID, then REVOKED after the state office revokes, and NOT_FOUND for unknown numbers`
* **Actions:** state approve → wait → `GET /api/verify/:number` (VALID); Farah revokes with
  reason; verify again; verify a random number.
* **Asserts:** `VALID` with a truthy candidate name; serialised payload **does not contain
  `"phone"`**; after revocation `REVOKED` with `revokeReason = 'Issued in error'`;
  unknown number → `NOT_FOUND`.
* **Proves:** test case 6 (revoked certificates fail verification), immediate effect, and
  no phone leakage.

#### D2 `does not let non-state roles revoke certificates`
* **Action:** Anika calls `POST /api/certificates/:id/revoke`.
* **Asserts:** 403; certificate still `VALID` in the database.
* **Proves:** revocation authorization is enforced server-side, not by hiding buttons.

---

### Requirement coverage map

| Hackathon test requirement | Test(s) |
| --- | --- |
| 1. Invalid upload does not partially save candidates | A1, A3 |
| 2. Two simultaneous approvals do not advance the batch twice | B1 |
| 3. One officer cannot approve twice | B2 |
| 4. Duplicate issuance does not create duplicate certificates | C1 |
| 5. WhatsApp failure does not create duplicate certificates | C2 |
| 6. Revoked certificates fail verification | D1 |
| 7. Unauthorized users cannot approve batches | B3, D2 |

Additional coverage not explicitly required but exercised: valid import transactionality
(A2), reason enforcement + resubmission with a new round (B4), `NOT_FOUND` verification and
no PII leakage (D1).

---

## Manual / end-to-end verification performed

| Check | Command | Observed result |
| --- | --- | --- |
| Type safety | `npm run check` | server + client `tsc --noEmit`, exit 0 |
| Automated suite | `npm test` | 11/11 passing, exit 0 |
| Production build | `npm run build --workspace client` | Vite build OK (JS 200 kB, CSS 18 kB) |
| Redis (Upstash, TLS) | `npm run redis:check` | `ok: true`, `tls: true`, ~20 ms, `source: REDIS_URL` |
| Health | `GET /api/health` | `database up`, `redis up`, `queueMode bullmq` |
| Worker fail-fast | `npm run worker:certificates` with Redis down | exits 1 with installation/`QUEUE_MODE=sync` guidance (no silent running) |
| Full workflow (BullMQ) | `npm run smoke` | upload → submit → 2 approvals → state → 3 certificates → 3 `SENT` deliveries → `VALID` |
| Real worker logs | certificate + notification workers | `processing issue-batch-…` → `created: 3, queuedDeliveries: 3`; 3 delivery jobs processed |
| Retry + backoff | phone ending `9` | attempt 1 failed, attempt 2 `SENT` (`attempts: 2`) |
| Multipart upload UI | browser, `samples/candidates.csv` | redirect to `/batch/:id`, `DRAFT`, 3 candidates, audit `BATCH_UPLOADED` |
| Row-error UI | browser, `samples/candidates-invalid.csv` | red panel listing `Row 3 - name …`, `Row 3 - phone …`; no batch created |
| Verification page | `/verify/<token>` | `VALID` badge, candidate/course/centre/date, PDF link, no phone |
| District/state views | browser as Dev, Farah | district scoping (`n/2` progress), state lists, revoke controls |
| PDF output | `server/storage/certificates/*.pdf` | one file per certificate, ~2.2 kB each |

---

## Adding tests

1. Put new cases in `server/tests/*.test.ts`; `setup.ts` truncates before each test.
2. Use `createBatch({ status, roundNumber, candidates })` to reach a state directly instead
   of replaying the whole workflow (faster, clearer failure attribution).
3. When background work is involved, always `await waitForSyncIdle()` before asserting.
4. Prefer asserting database state (`prisma.certificate.count()`) **and** the HTTP response —
   the tests are there to protect invariants, not just status codes.
5. For new queue-related code, remember the sync fallback must call the same service
   function so this test suite keeps covering the production logic.
