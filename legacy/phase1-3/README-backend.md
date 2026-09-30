# Assessment Platform

Internal assessment management platform (Admin / Learner / Examiner).
Next.js 16 (App Router) · TypeScript · Tailwind v4 + shadcn/ui · Prisma 7 · PostgreSQL 16.

> **Status:** Phase 3 — question bank with versioning, assessment management (admin). Learner attempts and examiner evaluation come next.

## Prerequisites

- Node.js ≥ 20.9 (developed on 24) and npm
- PostgreSQL 16, either via Docker (`docker compose`) or a local install

## Quick start

```bash
npm install                 # also runs `prisma generate`
cp .env.example .env        # then edit the CHANGE_ME values
npm run db:up               # only if using Docker for Postgres
npm run db:deploy           # apply migrations
npm run db:seed             # demo users, course, batch
npm run dev                 # http://localhost:3000
```

Demo accounts (password = `SEED_USER_PASSWORD` from your `.env`):

| Role     | Email                  |
| -------- | ---------------------- |
| Admin    | admin@example.com      |
| Examiner | examiner@example.com   |
| Learner  | learner1@example.com   |
| Learner  | learner2@example.com   |

## Environment variables

All variables live in `.env` (git-ignored). `.env.example` is the documented template.

| Variable             | Required | Used by                 | Description                                                                 |
| -------------------- | -------- | ----------------------- | --------------------------------------------------------------------------- |
| `DATABASE_URL`       | yes      | app, Prisma CLI, seed   | PostgreSQL connection string for the development database.                   |
| `TEST_DATABASE_URL`  | tests    | integration tests       | Separate database; it is migrated automatically and **truncated between tests**. Name must contain `test`. |
| `SESSION_TTL_HOURS`  | no       | app                     | Login session lifetime in hours. Default `12`.                              |
| `SEED_USER_PASSWORD` | seed     | `npm run db:seed`       | Password assigned to all demo accounts (min 8 chars).                       |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` / `POSTGRES_PORT` | Docker only | `docker-compose.yml` | Credentials for the local Postgres container; must match the URLs above. |

No auth secret is needed: sessions are random opaque tokens stored (hashed) in the database.

## Scripts

| Command                    | What it does                                               |
| -------------------------- | ---------------------------------------------------------- |
| `npm run dev`              | Dev server on :3000                                        |
| `npm run build` / `start`  | Production build / serve                                   |
| `npm run lint` / `typecheck` | ESLint / TypeScript checks                               |
| `npm test`                 | All tests (unit + integration)                             |
| `npm run test:unit`        | Unit tests only — no database needed                       |
| `npm run test:integration` | Integration tests against `TEST_DATABASE_URL`              |
| `npm run db:up` / `db:down`| Start / stop the Docker Postgres container                 |
| `npm run db:migrate`       | Create + apply a new migration after editing the schema (dev) |
| `npm run db:deploy`        | Apply pending migrations (CI / fresh setup)                |
| `npm run db:status`        | Show migration status                                      |
| `npm run db:seed`          | Seed demo data (idempotent)                                |
| `npm run db:reset`         | Drop and re-create the dev database from migrations        |
| `npm run db:studio`        | Prisma Studio data browser                                 |

## Project layout

```
prisma/                 schema.prisma, migrations/, seed.ts
src/
  proxy.ts              optimistic redirect to /login when no session cookie
  app/
    (auth)/             login page + login/logout server actions
    admin/ learner/ examiner/   role areas (layout + dashboard each)
    forbidden/  error.tsx  global-error.tsx  not-found.tsx
  components/ui/        shadcn/ui primitives
  components/shared/    app shell, status pages
  config/               site name, per-role navigation
  lib/auth/rbac.ts      pure role/route rules (shared by proxy, UI, server)
  lib/validation/       zod schemas
  server/
    auth/               password hashing, sessions, login service, guards
    services/           data access for pages (dashboard queries)
    audit.ts db.ts env.ts
tests/unit/             rbac, guards, proxy, credentials
tests/integration/      login + session lifecycle against a real database
```

## Assessments (Phase 2)

Lifecycle: `DRAFT → SCHEDULED → ACTIVE → ENDED → EVALUATION → RESULT_READY → PUBLISHED → ARCHIVED`
(rules in `src/lib/assessments/lifecycle.ts`).

- **DRAFT**: everything editable; questions can be added, removed, reordered and re-marked.
- **SCHEDULED**: questions are frozen (a snapshot is taken); only name, description and the window can change. Can go back to draft before the start time.
- **ACTIVE / ENDED** happen automatically when the start/end time passes (checked on every read/mutation). While active, only the end time can be extended; an admin can end early.
- Objective-only assessments go `ENDED → RESULT_READY`; anything with subjective questions goes through `EVALUATION`.
- **Question versioning:** each bank question has a version that increases when its text, options or answer change
  (not for marks/topic tweaks). Adding a question to an assessment copies it (snapshot + version). Bank edits never
  change that copy — in any status. While the assessment is a draft, an admin can explicitly **Use latest** to pull
  the newer version (assessment marks are kept).
- Questions can be **deactivated** (hidden from pickers, kept in existing assessments) or **deleted** if never used.
- All times are entered and shown in IST (Asia/Kolkata).

## Objective scoring rules

Implemented in `src/lib/scoring/objective.ts` (used by learner attempts in the next phase), always against the snapshot:
correct → full marks; wrong → minus negative marks; unanswered → 0; multiple-answer MCQs are all-or-nothing;
the assessment total is floored at 0.

## Auth & authorization model

- Email + password (bcrypt). Login creates a row in `sessions`; the browser gets an httpOnly
  `aap_session` cookie containing a random token, and only its SHA-256 hash is stored.
- Sessions expire after `SESSION_TTL_HOURS`; disabling a user invalidates their sessions immediately.
- `proxy.ts` only checks that the cookie exists. The real checks are `requireRole()` calls at the
  top of every protected page (and, later, every server action / route handler).
- Route → role rules live in one place: `src/lib/auth/rbac.ts`.
- Logins (success/failure) and logouts are written to `audit_logs`.

## Local Postgres without Docker (Windows)

Docker Desktop on Windows requires WSL. On this machine a portable PostgreSQL 16 is installed in
`%LOCALAPPDATA%\pgsql` with its data in `%LOCALAPPDATA%\pgsql-data` (localhost only). In PowerShell:

```powershell
# start
& "$env:LOCALAPPDATA\pgsql\bin\pg_ctl.exe" -D "$env:LOCALAPPDATA\pgsql-data" -l "$env:LOCALAPPDATA\pgsql-data\postgres.log" start
# status / stop
& "$env:LOCALAPPDATA\pgsql\bin\pg_ctl.exe" -D "$env:LOCALAPPDATA\pgsql-data" status
& "$env:LOCALAPPDATA\pgsql\bin\pg_ctl.exe" -D "$env:LOCALAPPDATA\pgsql-data" stop
```

It does not start automatically after a reboot.

## Note: timestamps in raw SQL

Prisma stores `DateTime` columns as `timestamp without time zone` holding **UTC**. When writing raw SQL,
use `now() AT TIME ZONE 'UTC'` rather than `now()` (the local Postgres session runs in IST).

## Known issue: OneDrive

If the project folder is inside OneDrive, OneDrive can lock files in `.next/` and cause
`EPERM: operation not permitted, rename ...` errors in `next dev`. Move the project outside
OneDrive (e.g. `C:\dev\`) or pause OneDrive syncing while developing.
