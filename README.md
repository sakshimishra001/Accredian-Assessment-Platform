# Assessment Platform

Internal assessment platform for an EdTech company, being moved from a clickable prototype to a real
backend one milestone at a time.

- **Real:** sign-in, sessions, logout and role-based route protection (PostgreSQL via Prisma).
- **Still mock:** everything after sign-in — assessments, papers, batches, results, communication — lives
  in memory and resets when the page is refreshed. No uploads, parsing, AI, proctoring or email.

## Run it

PostgreSQL must be running (see `legacy/phase1-3/README-backend.md` for setup). Then:

```bash
npm install
cp .env.example .env   # set DATABASE_URL, TEST_DATABASE_URL and SEED_USER_PASSWORD
npm run db:deploy      # apply migrations (never resets data)
npm run db:seed        # idempotent: creates/updates the demo accounts below
npm run dev            # http://localhost:3000
```

Next.js 16 · TypeScript · Tailwind v4 · shadcn/ui (Base UI). No new runtime dependencies were added for the prototype.

## Seeded accounts

Staff accounts use the password in `SEED_USER_PASSWORD` (your `.env`). Learners have **no permanent
password**: they sign in with their email plus an assessment-specific exam password. `npm run db:seed`
issues fresh exam passwords for the sample "Exam access demo" assessment on every run and prints them
(development only). The role picker only chooses the form; where you land is decided by the account.

| Role              | Email                                              | Signs in with          | Lands on    |
| ----------------- | -------------------------------------------------- | ---------------------- | ----------- |
| Administrator     | admin@example.com                                  | `SEED_USER_PASSWORD`   | `/admin`    |
| Examiner          | examiner@example.com, examiner1–5@example.com      | `SEED_USER_PASSWORD`   | `/examiner` |
| Doctor / Reviewer | reviewer@example.com                               | `SEED_USER_PASSWORD`   | `/reviewer` |
| Learner           | learner1@example.com, learner2@example.com         | exam password from the seed output | `/learner` |

Signed-out visitors to `/admin`, `/examiner`, `/reviewer` or `/learner` are sent to `/login`; a signed-in
user opening another role's area gets `/forbidden`.

## Demo script — the core admin journey

1. **Landing** → *Sign in to Platform* → choose **Administrator** → *Sign in*.
2. **Import Questions** → *Import Question Paper* → **PDF** → *Use sample* → watch the simulated extraction
   (32 questions · 30 objective · 2 subjective · 4 sections · 3 need review).
3. **Paper details** — sections with attempt rules (*Attempt any 5 of 8*, *Best 5 of 7 count*); add/remove sections.
4. **Review & edit** — filter *Needs review*; fix Q7 (set the correct answer), Q19 (marks) and Q28 (empty option),
   then *Mark as Reviewed*. Case study Q1 has nested parts 1(a)–1(c); comprehension Q26 has a passage.
5. **Approve** — checklist → *Approve Question Paper* → *Create Assessment*.
6. **Create Assessment wizard** — details (prefilled from the paper) → selected paper summary → configuration
   (randomize, resume, proctoring notice) → schedule (IST) → review → *Schedule Assessment* → confirm.
7. The assessment opens as **Scheduled**: Overview, Question Paper, Batch & Learners, Examiners (assign),
   Monitor and Results tabs. It also appears under *Assessments → Scheduled*.

Also try: the learner attempt (timer, palette, mark for review, submit), examiner evaluation (marks validation,
save, submit), reviewer *Request changes*, Users → *Create User*, Settings, and the collapsible / mobile sidebar.

## Routes

| Area     | Routes |
| -------- | ------ |
| Public   | `/` (landing, also `/landing`), `/login` |
| Admin    | `/admin`, `/admin/assessments`, `/admin/assessments/new`, `/admin/assessments/[id]`, `/admin/import-questions`, `/admin/import-questions/new`, `/admin/import-questions/[id]`, `/admin/batches`, `/admin/batches/[id]`, `/admin/examiners`, `/admin/examiners/[id]`, `/admin/proctoring`, `/admin/results`, `/admin/results/[id]`, `/admin/users`, `/admin/settings`, `/admin/profile`, `/admin/help` |
| Learner  | `/learner`, `/learner/assessments`, `/learner/assessment/[id]`, `/learner/profile`, `/learner/help` |
| Examiner | `/examiner`, `/examiner/evaluations`, `/examiner/evaluations/[id]`, `/examiner/profile`, `/examiner/help` |
| Reviewer | `/reviewer`, `/reviewer/papers/[id]`, `/reviewer/profile`, `/reviewer/help` |

## Code layout

```
src/app/                 routes; area layouts are server components that gate on the session
src/proxy.ts             optimistic cookie check → /login (no database access)
src/server/auth/         sessions, login/logout server actions, requireRole / requireAreaUser
src/components/ui/       shadcn/ui primitives (Base UI)
src/components/proto/    prototype design system & features: app shell, page chrome, controls,
                         status badges, activity chart, question/paper views, import wizard steps
src/prototype/
  types.ts               domain model (question papers, sections, attempt rules, assessments, …)
  data/                  deterministic mock data (5 courses, 7 batches / 1,248 learners, 28 papers, 12 assessments)
  store.tsx              in-memory React context: state + mock actions (resets on refresh)
  toast.tsx              toast notifications
  lib/                   formatting (IST), paper helpers (totals, attempt-rule text, validation)
```

## Backend

- Connected so far: authentication (`src/server/auth/`, `src/proxy.ts`, `src/lib/auth/`), and the
  service layer (no UI yet) for learners, assessment candidates, exam credentials and examiner
  assignment (`src/server/services/{learners,candidates,exam-credentials}.ts`).
- Not yet connected to the UI: the assessment and question-bank services in `src/server/services/`.
- `legacy/phase1-3/` — the old database-backed routes and UI (not compiled or routed), kept for reference,
  plus `README-backend.md` with the database setup instructions.
- Tests: `npm run test:unit`; `npm run test:integration` uses `TEST_DATABASE_URL` only (it refuses to run
  against a non-test or the development database, because it truncates tables).

## Security & production

See [docs/security.md](docs/security.md): production configuration (the server refuses to start with
missing or development-only settings), staff accounts and one-time password links, session lifetimes,
results-only access, file rules, the email outbox worker and the malware-scanning requirement.

## Known issue: OneDrive

The project folder is inside OneDrive, which locks files in `.next/` and can crash `next dev`
(`EPERM: operation not permitted, rename …`). The Turbopack dev cache is kept in memory to reduce this
(`next.config.ts`), but moving the project outside OneDrive (e.g. `C:\dev\`) is the real fix.
If the dev server crashes: stop it, delete the `.next` folder and run `npm run dev` again.
