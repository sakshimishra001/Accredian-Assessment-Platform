# Accredian Assessment Platform

Internal assessment platform for managing the complete assessment lifecycle.

## Features

- Question Paper creation & import
- Assessment creation, configuration & scheduling
- Batch & learner management
- Learner login with persistent passwords
- Timed assessments with autosave
- Text and file-based answers
- Examiner evaluation
- Results & PDF/CSV reports
- Proctoring: focus, fullscreen & clipboard monitoring
- Proctoring violation tracking and enforcement
- Communication templates & history
- Private Supabase Storage for uploaded files
- Role-based access control

## User Roles

- **Administrator** — manages assessments, learners, batches, examiners, users and results
- **Examiner** — evaluates learner submissions
- **Proctor** — monitors active assessments
- **Learner** — attempts assessments and views results

## Assessment Flow

Import Questions
→ Question Paper
→ Create Assessment
→ Configure
→ Select Batch & Learners
→ Assign Examiners
→ Schedule
→ Learner Attempt
→ Evaluation
→ Results

## Tech Stack

- Next.js 16
- React 19
- TypeScript
- Tailwind CSS
- shadcn/ui
- PostgreSQL
- Prisma 7
- Supabase Storage
- Vitest
- pdf-lib

## Setup

npm install
cp .env.example .env
npm run db:deploy
npm run db:seed
npm run dev

