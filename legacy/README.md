# Legacy (Phases 1–3)

Database-backed UI from Phases 1–3 (real auth, Prisma-backed question bank and assessments),
moved out of `src/app` when the product UI was restarted as a frontend-only clickable prototype.

Nothing here is routed or compiled. The backend it used is still in place and tested:
`src/server/`, `src/lib/`, `prisma/`, `tests/`. It will be reconnected in the backend phase.
