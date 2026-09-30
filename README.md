# Assessment Platform — clickable UI prototype

Internal assessment platform for an EdTech company. **This build is a frontend-only prototype**:
every screen, form, wizard, table and modal works, but all data is mock and lives in memory.

- No database, API, real authentication, uploads, parsing, AI, proctoring or email.
- Refreshing the browser resets everything to the demo data. That is intentional.
- PostgreSQL does **not** need to be running.

## Run it

```bash
npm install
npm run dev        # http://localhost:3000
```

Next.js 16 · TypeScript · Tailwind v4 · shadcn/ui (Base UI). No new runtime dependencies were added for the prototype.

## Demo accounts (prototype sign-in)

Choose the role on the sign-in screen; any password of 4+ characters works.

| Role              | Email                | Lands on    |
| ----------------- | -------------------- | ----------- |
| Administrator     | admin@example.com    | `/admin`    |
| Examiner          | examiner@example.com | `/examiner` |
| Doctor / Reviewer | doctor@example.com   | `/reviewer` |
| Learner           | learner@example.com  | `/learner` (type the captcha shown) |

Opening any role's URL directly (or refreshing) signs in that role's demo user automatically.

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
src/app/                 routes (client components; no server actions or API routes)
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

## Parked backend (Phases 1–3)

The earlier database-backed implementation is **not connected to this UI**:

- `legacy/phase1-3/` — the old routes, proxy and UI (not compiled or routed), plus `README-backend.md` with the
  database setup instructions.
- `src/server/`, `src/lib/`, `prisma/`, `tests/` — backend services, schema, migrations and tests, kept for the
  backend phase. `npm run test:unit` still passes; `npm run test:integration` needs PostgreSQL.

## Known issue: OneDrive

The project folder is inside OneDrive, which locks files in `.next/` and can crash `next dev`
(`EPERM: operation not permitted, rename …`). The Turbopack dev cache is kept in memory to reduce this
(`next.config.ts`), but moving the project outside OneDrive (e.g. `C:\dev\`) is the real fix.
If the dev server crashes: stop it, delete the `.next` folder and run `npm run dev` again.
