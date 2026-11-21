# CertiFlow — Module Reference

File-by-file catalogue: what it does, what it imports, what it exports, and the rules it
enforces. Line counts are approximate and intentionally omitted (they drift).

---

## 1. Server — config, libs, auth

### `server/src/config/env.ts`
* **Imports:** `dotenv/config`, `zod`.
* **Exports:** `env` (fully validated object), `redisTarget`, `redisConnectionOptions`.
* **Logic:** Zod schema for every variable (`DATABASE_URL`, `PORT`, `JWT_SECRET`,
  `REDIS_HOST/PORT/PASSWORD`, `REDIS_URL`, `QUEUE_MODE`, `STORAGE_DIR`, `PUBLIC_BASE_URL`,
  `WHATSAPP_MODE`, `WHATSAPP_MAX_ATTEMPTS`). On failure prints each issue and exits 1.
  `REDIS_URL` is parsed with `new URL()` to derive host/port/password and
  `tls = protocol === 'rediss:'`; malformed URL logs a warning and falls back to host/port.

### `server/src/lib/prisma.ts`
* **Exports:** `prisma` singleton (`PrismaClient`).
* **Logic:** Query logging only when `PRISMA_LOG=1`; warnings/errors always logged.
  Single client per process (API, each worker, tests).

### `server/src/lib/errors.ts`
* **Exports:** `HttpError`, `NonRetryableError`, factories (`badRequest`, `unauthorized`,
  `forbidden`, `notFound`, `conflict`), `asyncHandler`, `isUniqueViolation`.
* **Logic:** `HttpError` carries `status`, `message`, `code`, `details` (e.g. per-row CSV
  errors). `asyncHandler` wraps async routes so rejections reach the error middleware.
  `isUniqueViolation` checks Prisma `P2002`.

### `server/src/lib/audit.ts`
* **Exports:** `recordAudit(db, input)`, `recordAuditSafe(input)`.
* **Logic:** Inserts an `AuditLog` row (`actorId`, `action`, `entityType`, `entityId`,
  JSON `metadata`). The transactional variant accepts a `Prisma.TransactionClient` so the
  audit row commits atomically with the business change. `recordAuditSafe` swallows and
  logs failures for background/worker paths where an audit write must not break delivery.

### `server/src/lib/redis.ts`
* **Exports:** `checkRedis(timeoutMs = 2500)`, `redisHint(host, port)`.
* **Logic:** One bounded probe (`lazyConnect`, `connectTimeout`, `retryStrategy: () => null`,
  `enableOfflineQueue: false`), constructs the client from `REDIS_URL` (TLS) or host/port,
  `PING`, returns `{ok, host, port, tls, latencyMs?, error?}`, always disconnects.
  `redisHint` prints install options (Memurai / redis-server / WSL / `REDIS_URL`) and the
  `QUEUE_MODE=sync` alternative.

### `server/src/auth/middleware.ts`
* **Exports:** `signToken`, `authenticate`, `requireRole`, `AuthUser` type; augments
  `Express.Request` with `authUser`.
* **Logic:** JWT (`HS256`, 12 h, `sub` + `role`). `authenticate` verifies, then reloads the
  user from PostgreSQL (role/removal changes take effect immediately) and attaches
  `{id,name,email,role,district,trainingCentreId}`. `requireRole(...roles)` returns 403
  with the required roles.

---

## 2. Server — domain services

### `services/csvImport.ts`
* **Imports:** `csv-parse/sync`, `zod`.
* **Exports:** `parseCandidateCsv`, `normaliseHeader`, `normalisePhone`, types
  `ImportRow`, `RowError`, `ParseResult`.
* **Logic:** header aliasing (`candidate_name`, `full_name`, `mobile`, `skill`, …),
  BOM/trim handling, required-header check, per-row Zod validation collecting **all**
  issues, phone normalisation (`^\+?\d{8,15}$` after stripping `space ( ) . -`),
  case-insensitive duplicate-identifier detection inside the file. Row numbers are
  spreadsheet-accurate (`index + 2`). **No persistence** — pure function, unit-testable.

### `services/stateMachine.ts`
* **Exports:** `TRANSITIONS`, `TransitionName`, `assertTransition`, `canTransition`,
  `DISTRICT_APPROVALS_REQUIRED = 2`.
* **Transitions:**
  `SUBMIT DRAFT→PENDING_DISTRICT`, `RESUBMIT RETURNED→PENDING_DISTRICT`,
  `DISTRICT_APPROVED PENDING_DISTRICT→PENDING_STATE`,
  `DISTRICT_REJECT PENDING_DISTRICT→REJECTED`, `DISTRICT_RETURN PENDING_DISTRICT→RETURNED`,
  `STATE_APPROVE PENDING_STATE→APPROVED`, `STATE_REJECT PENDING_STATE→REJECTED`,
  `STATE_RETURN PENDING_STATE→RETURNED`, `ISSUE_CERTIFICATES APPROVED→ISSUED`.
* **Logic:** `assertTransition` throws `409` listing the allowed source states and echoes
  `{currentStatus, transition, allowedFrom}` in `details`.

### `services/batchService.ts`
* **Imports:** Prisma, errors, audit, `csvImport`, `stateMachine`.
* **Exports:** `listBatches`, `getBatchForUser`, `uploadBatch`, `submitBatch`,
  `resubmitBatch`, `visibleBatchWhere`, `BatchWithRelations`.
* **`visibleBatchWhere` scoping:**
  * centre → `trainingCentreId = mine`
  * district officer → `district = mine` and `status != DRAFT`
  * state office → `PENDING_STATE | APPROVED | ISSUED | RETURNED | REJECTED`
  * quality team → `status != DRAFT` (read-only in the UI; the API has no quality-only actions)
* **`getBatchForUser`** repeats those checks and throws 403 on cross-tenant access.
* **`uploadBatch`** — see [FLOW §2](./FLOW.md#2-batch-upload-csv--validation-is-all-or-nothing):
  validate everything → transaction create + audit; unique-violation → 409.
* **`submitBatch` / `resubmitBatch`** — `FOR UPDATE`, ownership, non-empty candidates,
  transition, new `ApprovalRound`, audit.
* **Include shape** used by detail/list: training centre, candidates ordered by
  `rowNumber`, rounds ordered with approvals + officer names, certificates + delivery job.

### `services/approvalService.ts`
* **Exports:** `recordDistrictDecision`, `recordStateDecision`, `DecisionInput`.
* **Logic:** district and state decisions — reasons required for non-approvals, row lock,
  district match, status check, open-round check, unique-approval handling, 2-of-N
  promotion, audit rows. Full sequence in [FLOW §4–5](./FLOW.md#4-district-approval-two-distinct-officers).
* **State function returns** `{updated, shouldIssue, message}` — the route enqueues
  issuance only when `shouldIssue`, after the transaction commits.

### `services/certificateService.ts`
* **Exports:** `issueCertificatesForBatch`, `IssuanceSummary`.
* **Logic:** status gate (`APPROVED`/`ISSUED`, else `NonRetryableError`), per-candidate
  `ensureCertificate` (find → create → tolerate `P2002` → reuse), PDF render only when
  `pdfPath` is null, `DeliveryJob.upsert`, enqueue unless `SENT`/`FAILED` or certificate
  revoked, `updateMany` `APPROVED→ISSUED`, audit summary. Number format
  `CF-<batchRef>-<row padded 3>`; token `crypto.randomBytes(16).hex`.

### `services/pdf.ts`
* **Imports:** `node:fs`, `node:path`, `pdfkit`, Prisma types, `env`.
* **Exports:** `renderCertificatePdf`, `verificationUrl`.
* **Logic:** `mkdir(storage, recursive)`, A4 landscape document, blue double border,
  "CERTIFLOW / SKILL CERTIFICATION AUTHORITY", "Certificate of Completion", candidate
  name/course, centre, three-column meta (number, issue date, candidate id), verification
  URL + short code footer. Streams to `<certificateNumber>.pdf`, rejects on stream/doc
  errors, returns the storage-relative path (`env.STORAGE_DIR` with `/` separators).

### `services/whatsapp.ts`
* **Imports:** `env`.
* **Exports:** `sendWhatsAppMessage`, `WhatsAppError`.
* **Logic:** 120 ms simulated latency; `WHATSAPP_MODE` override
  (`success` / `failure` / `timeout`); in `mixed` the phone's last digit selects
  permanent failure (`7`), timeout (`8`), first-attempt failure (`9`), otherwise success.
  `WhatsAppError` carries `retryable` + `code`. Returns a fake `wamid.SIM-…` provider ref.

### `services/deliveryService.ts`
* **Exports:** `processDelivery`.
* **Logic:** load job with certificate/candidate/batch/centre; no-op when `SENT`; fail when
  certificate `REVOKED`; persist `attempts + 1` **before** calling the provider; on success
  set `SENT`/`sentAt`/`providerRef`/clear error; on failure mark `PENDING` (retryable and
  attempts remain, then rethrow for BullMQ) or `FAILED` (permanent/exhausted); audit both
  outcomes. Never writes `Certificate`.

### `services/verificationService.ts`
* **Exports:** `verifyByNumber`, `verifyByToken`, `toPublicCertificate`,
  `revokeCertificate`, `revokeBatchCertificates`, `PublicCertificate`.
* **Logic:** lookups by `certificateNumber` or `verificationToken`; public projection
  excludes phone; `NOT_FOUND` shape for unknown numbers; revocation under `FOR UPDATE`,
  idempotency check (`already revoked` → 409), pending deliveries failed, audits
  (`CERTIFICATE_REVOKED`, `BATCH_CERTIFICATES_REVOKED`).

---

## 3. Server — queue and workers

### `queue/connection.ts`
* **Exports:** `createRedisClient(name)`.
* **Logic:** one factory for producers and workers. `REDIS_URL` → `new IORedis(url, opts)`
  (TLS automatic for `rediss://`), else host/port/password (+ `tls: {}` if a TLS URL was
  parsed). `maxRetriesPerRequest: null` (BullMQ requirement), ready check, connection name
  `certiflow:<name>`, capped retry strategy, error logging.

### `queue/queues.ts`
* **Exports:** `QUEUE_PREFIX = 'certiflow'`, `CERTIFICATE_QUEUE = 'certificate-issuance'`,
  `DELIVERY_QUEUE = 'whatsapp-delivery'`, `defaultJobOptions`, `getCertificateQueue`,
  `getDeliveryQueue`, `closeQueues`.
* **Logic:** lazy `Queue` singletons; certificate jobs `attempts: 5`, delivery jobs
  `attempts: 4` (overridden per add), exponential backoff, `removeOnComplete`/`removeOnFail`
  bounded so Redis does not grow unboundedly.

### `queue/dispatch.ts`
* **Exports:** `resolveQueueMode`, `getResolvedQueueMode`, `enqueueCertificateIssuance`,
  `enqueueDelivery`, `waitForSyncIdle`, `resetQueueModeCache`.
* **Logic:** mode resolution cached per process; BullMQ path adds jobs with deterministic
  `jobId`s (`issue-batch-<batchId>`, `delivery-<deliveryJobId>`) to prevent duplicate
  enqueues; sync path runs the identical service function with bounded retry
  (issuance 2 × 800 ms, delivery `WHATSAPP_MAX_ATTEMPTS` × 400 ms exponential) and tracks
  promises so tests can await completion.

### `workers/certificateWorker.ts`
* **Logic:** resolve mode → if not `bullmq`, print `workerBlockedMessage` and exit 1;
  else `new Worker('certificate-issuance', job => issueCertificatesForBatch(job.data.batchId))`,
  concurrency 2, `failed`/`error` logging, graceful `SIGINT`/`SIGTERM` close.

### `workers/notificationWorker.ts`
* **Logic:** same pattern for `whatsapp-delivery` → `processDelivery(deliveryJobId)`,
  concurrency 3.

### `workers/requirements.ts`
* **Exports:** `workerBlockedMessage(label, info)`.
* **Logic:** distinguishes "Redis unreachable" (prints `redisHint`) from
  `QUEUE_MODE=sync` (configuration explanation).

### `scripts/checkRedis.ts` + `npm run redis:check`
* Prints `{host, port, tls, ok, latencyMs, source, queueMode}` and exits 1 with guidance on
  failure.

---

## 4. Server — HTTP layer

### `src/app.ts`
* **Exports:** `createApp()`, `startServer()`.
* **Logic:** `cors()`, JSON (2 MB) + urlencoded parsing, static `/storage`, `/api/health`
  (`prisma SELECT 1` + `checkRedis(800)` + cached queue mode), mounts `/api/auth`,
  `/api/batches`, `/api/certificates`, `/api/verify`, 404 JSON, error middleware.
  `startServer()` performs DB/mode preflight, listens, and wires graceful shutdown.
* **Tests import `createApp()` directly** — no port binding.

### `middleware/errorHandler.ts`
* **Logic:** maps `HttpError` → its status/payload; `ZodError` → 400 `VALIDATION_ERROR`
  with `details[]`; `MulterError` → 400 `UPLOAD_ERROR` (includes 2 MB message);
  `PrismaClientKnownRequestError` → 404 (`P2025`) or 409;
  `PrismaClientInitializationError` → 503 `DB_UNAVAILABLE` with a PostgreSQL hint;
  otherwise 500 `INTERNAL` (details only in server logs).

### `routes/auth.ts`
* `GET /demo-users` (public, includes training centre), `POST /demo-login`
  (Zod `userId`, 401 when unknown), `GET /me` (authenticated echo).

### `routes/batches.ts`
* Multer memory storage (2 MB) for `POST /`; accepts multipart `file` **or** JSON `{csv}`.
* `GET /` validates the `status` filter against the enum, applies `listBatches`.
* `GET /:id` returns `{batch, ui, auditLogs}`; audit query unions batch, certificate and
  delivery-job entity ids and includes actor name/role.
* `POST /:id/submit|resubmit|decisions|state-decision|issue|revoke-certificates`,
  `GET /:id/audit`.
* `availableActions(user, batch)` is the single source of truth for UI buttons and also
  returns `myDecision`, `districtApprovals`, `requiredDistrictApprovals`,
  `currentRoundNumber`.

### `routes/certificates.ts`
* `GET /:id/pdf` — authenticated, scoped (state/quality/owning centre/same district) and
  `sendFile` with `Content-Type: application/pdf`; 404 if path/file missing.
* `POST /:id/revoke` — state office only, Zod reason ≥ 3 chars.

### `routes/verify.ts`
* Ordering matters: `/token/:token` and `/token/:token/pdf` are registered **before**
  `/:certificateNumber`, otherwise `token` would be parsed as a number.
* Public: token result, token PDF, number result.

---

## 5. Frontend

### `client/src/main.tsx`
* React 18 `createRoot`, `BrowserRouter`, `AuthProvider`, `App`, Tailwind entry.

### `client/src/api.ts`
* `api<T>(path, options)` → `fetch('/api' + path)`, bearer from localStorage,
  JSON content-type unless `FormData`, parses JSON, throws `ApiError(status, message, details)`,
  clears session on 401 (except auth calls).
* `getToken/setSession/clearSession/getStoredUser`, `downloadPdf(path, filename)` (fetches
  the protected PDF with bearer and triggers a blob download).
* Keys: `certiflow.token`, `certiflow.user`.

### `client/src/auth.tsx`
* Context with `{user, login, logout}`; hydrates from localStorage only when a token exists.

### `client/src/App.tsx`
* Route table + `RequireAuth` (redirect to `/login`, role mismatch → `homeFor(role)`),
  `Layout` header with role-aware navigation and "Switch user", `homeFor` mapping
  (centre → `/dashboard`, officer → `/officer`, state/quality → `/state`).

### `client/src/ui.tsx`
* `STATUS_STYLES` / `STATUS_LABELS`, `ROLE_LABELS`, `formatDate`, `StatusPill`,
  `ErrorBox` (renders `details.errors[{row, field, message}]`).

### `client/src/types.ts`
* Shared DTO types mirroring the API JSON (`Batch`, `Candidate`, `ApprovalRound`,
  `Certificate`, `DeliveryJob`, `AuditLog`, `PublicCertificate`, `UiInfo`, …).

### `client/src/pages/LoginPage.tsx`
* Loads demo users, one click logs in and navigates to the role home; shows centre/district
  scope on each card; login replaces any existing session.

### `client/src/pages/TrainingDashboard.tsx`
* `GET /batches`, four status counters (draft / pending district / pending state / issued),
  table with reference, course, candidate count, status pill, round, submitted date.

### `client/src/pages/UploadBatchPage.tsx`
* File input (`.csv`), posts `FormData` with bearer, shows row errors, downloads a sample
  CSV via `Blob`, explains the workflow and the xlsx limitation.

### `client/src/pages/OfficerQueuePage.tsx`
* Shows `PENDING_DISTRICT` batches for the officer's district with `n/2` approval progress
  and `You: <decision>` when the officer already voted; separate list of other batches.

### `client/src/pages/StateQueuePage.tsx`
* Sections: awaiting final approval, issued certificates, returned/rejected; quality team
  sees the same data read-only (no action buttons appear because the server omits actions).

### `client/src/pages/BatchDetailPage.tsx`
* Fetches `{batch, ui, auditLogs}`; renders action panel from `ui.actions`
  (submit/resubmit, district or state decision with a required reason for return/reject,
  retry issuance, batch revocation), approval history per round, candidate table,
  certificate + delivery table (attempts, last error, PDF download, per-certificate revoke),
  and the audit trail. After a state approval it reloads again after 1.5 s so the
  asynchronously issued certificates appear.

### `client/src/pages/VerifyPage.tsx`
* Public form; accepts certificate number or 32-hex token; auto-verifies `/verify/:token`;
  renders `VALID`/`REVOKED`/`NOT_FOUND` with details (no phone), revocation reason and a
  public PDF link.

---

## 6. Database artefacts

### `prisma/schema.prisma`
Nine models (`User`, `TrainingCentre`, `Batch`, `Candidate`, `ApprovalRound`, `Approval`,
`Certificate`, `DeliveryJob`, `AuditLog`), five enums, all timestamps (`createdAt`,
`updatedAt` where mutable), foreign keys with `onDelete: Cascade` where a child cannot
outlive its parent (candidates/rounds/delivery jobs), and the unique constraints listed in
[ARCHITECTURE §4](./ARCHITECTURE.md#constraints-that-carry-business-meaning).

### `prisma/migrations/0_init/migration.sql`
Generated with `prisma migrate diff --from-empty --to-schema-datamodel` (no shadow database),
applied with `prisma migrate deploy`. `migration_lock.toml` declares `postgresql`.

### `prisma/seed.ts`
Idempotent upserts (by code / email): two training centres (Pune, Nagpur) and six demo
users (Anika, Dev, Meera, Kabir, Neha, Farah). Prints the seeded table.

---

## 7. Tooling and scripts

| Path | Purpose |
| --- | --- |
| `scripts/setup-db.js` | One-time DB bootstrap: prompts for the superuser password (hidden), creates role `certiflow` (LOGIN/CREATEDB) and databases `certiflow` + `certiflow_test`, rewrites `DATABASE_URL` in `server/.env`, generates Prisma client, creates `0_init` migration via `migrate diff`, `migrate deploy`, seed |
| `scripts/smoke-test.mjs` | HTTP walkthrough (health → upload → submit → 2 approvals → state → issuance/delivery → verification, optional `--revoke`) |
| `scripts/checkRedis.ts` (`npm run redis:check`) | Redis reachability/TLS/latency diagnostic |
| `server/vitest.config.ts` | Points tests at `<db>_test`, sets `QUEUE_MODE=sync`, `WHATSAPP_MODE=mixed`, storage test dir, single forked worker |
| `server/tests/globalSetup.ts` | Runs `prisma migrate deploy` against the test database |
| `server/tests/setup.ts` | `beforeEach` truncate + storage cleanup, `afterAll` disconnect |
| `server/tests/helpers.ts` | `seedDemoData`, `createBatch`, `bearer`, `waitFor` |
| `client/vite.config.ts` | Port 5173, proxies `/api` and `/storage` to 4000 |
