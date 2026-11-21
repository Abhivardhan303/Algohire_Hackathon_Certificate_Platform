# CertiFlow - Hackathon MVP

Certificate issuance and public verification for training centres, district offices and the
state office. Built as a **modular monolith** that runs entirely on local Windows processes.

> **No Docker required.** PostgreSQL and Redis run as normal local services/processes.
> Redis is optional: when it is not reachable the app uses an explicitly configured,
> clearly logged synchronous fallback (see [Queue modes](#queue-modes)).

---

## Documentation

| Document | Contents |
| -------- | -------- |
| [DEPLOYMENT.md](DEPLOYMENT.md) | Production plan for 100k users / 10k DAU / results day (500 batches, 30k PDFs, 30k WhatsApp): architecture, hosting choices, scaling and backlog math, failure runbooks, S3 storage and access control, monitoring/alerts, cost and trade-offs, container images and roll-out checklist |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System topology, layer responsibilities, module dependency graph, ER diagram, every constraint and package (with where/why) |
| [docs/FLOW.md](docs/FLOW.md) | End-to-end runtime flows with sequence diagrams: startup, login, CSV upload, submit/resubmit, district approvals, state approval, issuance, WhatsApp delivery, verification, revocation, error paths |
| [docs/DIAGRAMS.md](docs/DIAGRAMS.md) | Six Mermaid diagrams: master end-to-end flowchart, happy-path sequence, batch state machine, delivery state machine, queue/worker topology, CSV validation pipeline |
| [docs/MODULES.md](docs/MODULES.md) | File-by-file reference: imports, exports, logic, invariants for server, queue/workers, routes, frontend, schema, scripts |
| [docs/API.md](docs/API.md) | Every endpoint: auth, request/response examples, status codes, error envelopes |
| [docs/TESTING.md](docs/TESTING.md) | Test infrastructure, all 11 tests with their assertions, requirement coverage map, manual verification log |

## 1. Stack

| Layer      | Technology |
| ---------- | ---------- |
| Frontend   | React + Vite + TypeScript + React Router + Tailwind CSS |
| Backend    | Node.js + Express + TypeScript + Zod |
| Database   | PostgreSQL + Prisma (source of truth) |
| Queues     | Redis + BullMQ (certificate generation and WhatsApp delivery workers) |
| Certificates | PDFKit (stored on local disk) |
| Tests      | Vitest + Supertest (real PostgreSQL test database) |

## 2. Project layout

```
Certificate_Platform/
  package.json            npm workspaces + dev/worker/db scripts
  scripts/setup-db.js     one-time local DB bootstrap (role, DBs, .env, migrate, seed)
  server/
    prisma/schema.prisma  User, TrainingCentre, Batch, Candidate, ApprovalRound,
                          Approval, Certificate, DeliveryJob, AuditLog
    prisma/seed.ts        demo users and training centres
    src/
      app.ts, index.ts    Express app + startup checks (DB / Redis diagnostics)
      auth/               demo-login JWT + role middleware
      services/           csv import, batch, approval, certificate, delivery,
                          whatsapp simulation, PDF template, verification
      queue/              shared Redis connection, BullMQ producers, sync fallback
      workers/            certificate worker, notification worker (separate processes)
    tests/                Vitest + Supertest integration tests
  client/                 React SPA
```

## 3. Prerequisites (Windows, no Docker)

1. **Node.js 18+** (tested with Node 20) - `node -v`
2. **PostgreSQL 16** installed and running as a Windows service
   (`Get-Service postgresql*`). `psql` is usually at
   `C:\Program Files\PostgreSQL\16\bin\psql.exe`.
3. **Redis-compatible server (optional but recommended)** - any one of:
   * a hosted Redis such as **Upstash** via `REDIS_URL` (TLS is enabled automatically for
     `rediss://` URLs) - this is what the current demo uses
   * `winget install Memurai.MemuraiDeveloper` (Redis-compatible Windows service)
   * a Windows `redis-server.exe` build started manually
   * WSL: `sudo service redis-server start`
   Verify with `npm run redis:check` (or `redis-cli ping` -> `PONG`).

## 4. First-time setup

```powershell
# 1. install dependencies (root, uses npm workspaces)
npm install

# 2. create role + databases, write server/.env, run migrations, seed demo users
npm run db:setup
#    -> asks for your PostgreSQL superuser ("postgres") password once.
#       It creates the "certiflow" role (password certiflow_dev), the "certiflow"
#       and "certiflow_test" databases and writes DATABASE_URL to server/.env.

# 3. (optional) start Redis, then check
redis-cli ping
```

`npm run db:setup` runs, in order: `prisma generate`, creation of the `0_init` migration
with `prisma migrate diff` (no shadow database required), `prisma migrate deploy` and
`tsx prisma/seed.ts`. If you later change `prisma/schema.prisma`, either grant the role
`CREATEDB` and use `npx prisma migrate dev --name <name>` in `server/`, or regenerate the
SQL with `prisma migrate diff` and apply it with `prisma migrate deploy`.

### Environment variables (`server/.env`)

| Variable | Default | Purpose |
| -------- | ------- | ------- |
| `DATABASE_URL` | `postgresql://postgres:12345678@localhost:5432/certiflow` | PostgreSQL connection |
| `PORT` | `4000` | API port |
| `JWT_SECRET` | dev value | Demo-login token signing |
| `REDIS_HOST` / `REDIS_PORT` / `REDIS_PASSWORD` | `127.0.0.1` / `6379` / empty | Shared Redis connection |
| `REDIS_URL` | empty | Optional full Redis URL; takes precedence | `QUEUE_MODE` | `auto` | `auto` / `bullmq` / `sync` (see below) |
| `STORAGE_DIR` | `./storage/certificates` | Persistent certificate PDF directory |
| `PUBLIC_BASE_URL` | `http://localhost:5173` | Verification URL printed on PDFs |
| `WHATSAPP_MODE` | `mixed` | `mixed` / `success` / `failure` / `timeout` |
| `WHATSAPP_MAX_ATTEMPTS` | `4` | Delivery retry ceiling |

Credentials are never hard-coded in the application code.

## 5. Running

```powershell
npm run dev               # API (4000) + frontend (5173)
npm run dev:all           # API + frontend + both BullMQ workers (needs Redis)
npm run dev:backend       # API only
npm run dev:frontend      # Vite only
npm run worker:certificates
npm run worker:notifications
```

Open <http://localhost:5173> and pick a demo user. `npm run dev` omits the workers: with
`QUEUE_MODE=auto` and no Redis, all background work runs in-process via the documented
fallback, which is what the demo uses on this machine.

Other scripts: `npm run db:migrate`, `npm run db:seed`, `npm run test`, `npm run check`,
`npm run build`, `npm run smoke` (end-to-end HTTP walkthrough against a running API, add
`-- --revoke` to also exercise revocation).

Sample CSV files for the upload page live in `samples/` (`candidates.csv` is valid,
`candidates-invalid.csv` demonstrates row-level errors).

## 6. Queue modes

BullMQ is **only** used with a real Redis server. There is no in-memory fake queue
pretending to be BullMQ.

| `QUEUE_MODE` | Behaviour |
| ------------ | --------- |
| `auto` (default) | Probe Redis with a bounded `PING`. If reachable -> BullMQ queues + workers. Otherwise -> synchronous fallback with a loud console warning. |
| `bullmq` | Require Redis. Startup fails fast with installation instructions if Redis is unreachable. |
| `sync` | Explicit fallback. No Redis, no BullMQ. |

Synchronous fallback details:

* Certificate issuance and WhatsApp delivery run inside the API process, in order, using
  the **same service functions** as the workers (same state machine, same idempotency
  rules, same database constraints).
* Retries use the same exponential backoff parameters as the BullMQ jobs.
* The API reports the active mode at `GET /api/health` (`queueMode`, `queueReason`).
* When Redis is available, the two worker processes are:

```powershell
npm run worker:certificates     # certificate-issuance queue
npm run worker:notifications    # whatsapp-delivery queue
```

Both workers share the same Redis connection settings, log job failures, and shut down
gracefully on `SIGINT`/`SIGTERM` (active jobs finish first).

### Hosted Redis (Upstash)

Set `REDIS_URL` in `server/.env` - it takes precedence over `REDIS_HOST/PORT/PASSWORD`:

```dotenv
REDIS_URL=rediss://default:<password>@<region>-<name>.upstash.io:6379
```

`rediss://` automatically enables TLS. Check it with `npm run redis:check`, then start the
backend and both workers (`npm run dev:all`). Verified in this workspace: BullMQ issued 3
certificates in the certificate worker, the notification worker delivered them, and a
simulated temporary failure was retried with exponential backoff (attempts: 2 -> SENT).

Keep credentials in `server/.env` only (git-ignored); rotate any credential that has been
shared in chat or committed by mistake.

## 7. Business workflow

```
Training centre uploads CSV (draft)
        -> submit
PENDING_DISTRICT  -- officer A approves --> still PENDING_DISTRICT (1/2)
                  -- officer B approves --> PENDING_STATE      (2 distinct officers)
                  -- return / reject     --> RETURNED / REJECTED
PENDING_STATE     -- state approves     --> APPROVED -> certificate jobs -> ISSUED
                  -- return / reject     --> RETURNED / REJECTED
RETURNED          -- resubmit           --> PENDING_DISTRICT (new approval round)
APPROVED / ISSUED -- state revokes      --> certificates REVOKED (verification shows REVOKED)
```

Implementation notes:

* `server/src/services/stateMachine.ts` is the only place status transitions are defined;
  there is no generic "update status" endpoint.
* District decisions lock the batch row with `SELECT ... FOR UPDATE`, so simultaneous
  approvals are serialised. `@@unique([roundId, officerId])` blocks a second decision from
  the same officer even under concurrency.
* State approval is committed **before** certificate issuance is enqueued, so a queue
  outage can never lose an approved batch (`POST /api/batches/:id/issue` re-requests it).
* Certificate issuance is idempotent: `Certificate.candidateId` and
  `Certificate.certificateNumber` are unique; retries reuse the existing row, PDF and
  delivery job.
* WhatsApp delivery never creates certificates. It only updates `DeliveryJob`.

## 8. Demo users (seeded)

| Name | Role | Scope |
| ---- | ---- | ----- |
| Anika | Training centre | Pune Skills Academy |
| Dev | District officer | Pune |
| Meera | District officer | Pune |
| Kabir | District officer | Nagpur |
| Neha | Quality team | read-only overview |
| Farah | State office | final approval + revocation |

Login is a demo picker (no passwords). Every API request still carries a JWT and the
backend enforces roles and district/centre scoping on every batch access.

## 9. CSV import

Headers (aliases accepted): `name`, `identifier`, `course`, `phone`.
Example: `client/src/pages/UploadBatchPage.tsx` has a "Download sample CSV" button.

* All rows are validated before anything is written. Any invalid row rejects the whole
  import with row-specific errors - **no partial saves**.
* The batch + candidates are created in a single PostgreSQL transaction.
* `.xlsx` is **not** supported in this MVP; export to CSV. Documented limitation.

## 10. WhatsApp simulation

No real WhatsApp integration. `WHATSAPP_MODE=mixed` (default) derives behaviour from the
last digit of the candidate phone number:

| Last digit | Simulated provider behaviour |
| ---------- | ---------------------------- |
| `7` | Permanent failure (non-retryable, `DeliveryJob` -> `FAILED`) |
| `8` | Timeout on every attempt (retryable, exhausts retries) |
| `9` | Temporary failure on attempt 1, succeeds on attempt 2 |
| other | Success |

`WHATSAPP_MODE=success|failure|timeout` forces one behaviour for all numbers.
`DeliveryJob.attempts`, `status`, `lastError` and `sentAt` are tracked in PostgreSQL.

## 11. Public verification

* `GET /api/verify/:certificateNumber` and `GET /api/verify/token/:token` (used by the URL
  on the PDF) return `VALID`, `REVOKED` or `NOT_FOUND`.
* Revocation takes effect immediately and cancels pending deliveries.
* Only name, identifier, course, centre, issue date and status are exposed - no phone
  numbers.
* Public PDF: `GET /api/verify/token/:token/pdf`.

## 12. Tests

```powershell
npm run test
```

Vitest uses a dedicated `certiflow_test` database (migrations applied automatically).
Covered scenarios:

1. An invalid row rejects the entire upload - nothing is partially saved.
2. Two simultaneous district approvals record both decisions and advance the batch once.
3. The same officer cannot approve twice (409, unique constraint).
4. Duplicate issuance does not create duplicate certificates.
5. A failed WhatsApp delivery does not create another certificate.
6. Revoked certificates fail verification (`REVOKED`).
7. Unauthorized users (other district, wrong role) cannot approve.

## 13. API summary

| Method | Path | Who |
| ------ | ---- | --- |
| GET | `/api/health` | public |
| GET | `/api/auth/demo-users` | public |
| POST | `/api/auth/demo-login` | public |
| GET | `/api/batches` | authenticated (scoped) |
| POST | `/api/batches` | training centre (CSV `file` or `{ csv }`) |
| GET | `/api/batches/:id` | authenticated (scoped) |
| POST | `/api/batches/:id/submit` | training centre |
| POST | `/api/batches/:id/resubmit` | training centre |
| POST | `/api/batches/:id/decisions` | district officer |
| POST | `/api/batches/:id/state-decision` | state office |
| POST | `/api/batches/:id/issue` | state office (retry issuance) |
| POST | `/api/batches/:id/revoke-certificates` | state office |
| GET | `/api/batches/:id/audit` | authenticated (scoped) |
| GET | `/api/certificates/:id/pdf` | authenticated (scoped) |
| POST | `/api/certificates/:id/revoke` | state office |
| GET | `/api/verify/:certificateNumber` | public |
| GET | `/api/verify/token/:token` | public |
| GET | `/api/verify/token/:token/pdf` | public |

## 14. Troubleshooting

* **`PostgreSQL is not reachable`** - start the service (`Get-Service postgresql*`,
  `Start-Service postgresql-x64-16`), then check `DATABASE_URL` in `server/.env`.
* **`Redis is not reachable at 127.0.0.1:6379`** - either a local Redis/Memurai is not
  running, or `REDIS_URL` is wrong. Run `npm run redis:check` for the exact host/TLS state.
  Either start local Redis and restart the workers, or keep `QUEUE_MODE=auto`/`sync` and the
  backend will use the documented fallback. The workers intentionally exit with
  instructions instead of silently pretending to run.
* **Workers exit immediately** - they require Redis by design (`QUEUE_MODE=bullmq` when
  started directly).
* **Port 4000 in use** - change `PORT` in `server/.env` and the Vite proxy in
  `client/vite.config.ts`.

## 15. Docker (not used for this demo)

Docker Desktop is unavailable on this machine, so the app is verified purely with local
Windows processes. A Dockerfile/Compose setup is intentionally out of scope for the MVP;
the queue layer is Redis-compatible, so containerising later only requires pointing
`DATABASE_URL` and `REDIS_HOST` at containers and running the same npm scripts.
