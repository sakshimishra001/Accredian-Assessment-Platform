"use client";

import Link from "next/link";
import {
  ArrowRight,
  BarChart3,
  CalendarClock,
  CircleCheck,
  ClipboardList,
  FileUp,
  Layers,
  ShieldCheck,
  SquareCheckBig,
  Users,
} from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { Logo } from "./app-shell";

const WORKFLOW = [
  { icon: FileUp, title: "Import", detail: "Excel, Word or PDF question papers" },
  { icon: SquareCheckBig, title: "Review & approve", detail: "Sections, marks and answer keys" },
  { icon: CalendarClock, title: "Schedule", detail: "Assign a paper to a batch" },
  { icon: ClipboardList, title: "Attempt", detail: "Timed, auto-saved learner attempts" },
  { icon: Users, title: "Evaluate", detail: "Examiners mark subjective answers" },
  { icon: BarChart3, title: "Results", detail: "Publish and report outcomes" },
];

const FEATURES = [
  { icon: Layers, title: "Question papers, not question lists", body: "Import complete papers with sections, attempt rules, case studies and nested sub-questions — then reuse them across batches." },
  { icon: CalendarClock, title: "Assessments in five steps", body: "Pick a batch, select a question paper, configure rules and schedule. No hand-picking thirty questions." },
  { icon: Users, title: "Batches and examiners", body: "Manage cohorts, invite learners and route subjective scripts to examiners with clear due dates." },
  { icon: BarChart3, title: "Results and reporting", body: "Track pass rates by assessment, batch and learner, and see where evaluation is holding things up." },
  { icon: ShieldCheck, title: "Ready for proctoring", body: "A clean integration point for third-party proctoring providers when you need it." },
  { icon: CircleCheck, title: "Built for operations teams", body: "Status at a glance, confirmations before anything irreversible, and an audit-friendly workflow." },
];

function WorkflowVisual() {
  return (
    <div className="rounded-2xl border bg-card p-4 shadow-sm md:p-6">
      <div className="mb-4 flex items-center justify-between">
        <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Assessment workflow</span>
        <span className="text-xs text-muted-foreground">PM-01 – Mid Term 1</span>
      </div>
      <ol className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {WORKFLOW.map((step, i) => (
          <li key={step.title} className="relative flex items-start gap-3 rounded-lg border bg-background p-3">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
              <step.icon className="size-4" aria-hidden />
            </span>
            <span className="min-w-0">
              <span className="flex items-center gap-2 text-sm font-medium">
                <span className="text-xs text-muted-foreground tabular-nums">{String(i + 1).padStart(2, "0")}</span>
                {step.title}
              </span>
              <span className="mt-0.5 block text-xs text-muted-foreground">{step.detail}</span>
            </span>
            {i < 3 ? <CircleCheck className="ml-auto size-4 shrink-0 text-emerald-600" aria-label="Done" /> : null}
            {i === 3 ? <span className="ml-auto shrink-0 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">Live</span> : null}
          </li>
        ))}
      </ol>
      <div className="mt-4 grid grid-cols-3 gap-3 border-t pt-4 text-center">
        {[
          ["186", "Learners"],
          ["32", "Questions"],
          ["70", "Marks"],
        ].map(([v, l]) => (
          <div key={l}>
            <div className="text-lg font-semibold tabular-nums">{v}</div>
            <div className="text-xs text-muted-foreground">{l}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function LandingPage() {
  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-30 border-b bg-background/90 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4 md:px-6">
          <Link href="/" aria-label="Assessment Platform">
            <Logo />
          </Link>
          <nav className="hidden items-center gap-6 text-sm text-muted-foreground md:flex" aria-label="Site">
            <a href="#features" className="hover:text-foreground">Features</a>
            <a href="#how-it-works" className="hover:text-foreground">How it works</a>
            <a href="#support" className="hover:text-foreground">Support</a>
          </nav>
          <Link href="/login" className={buttonVariants({ variant: "outline" })}>
            Sign in
          </Link>
        </div>
      </header>

      <section className="mx-auto grid max-w-6xl items-center gap-10 px-4 py-16 md:px-6 md:py-24 lg:grid-cols-[1.05fr_1fr]">
        <div>
          <p className="mb-4 inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs text-muted-foreground">
            <span className="size-1.5 rounded-full bg-primary" aria-hidden />
            Internal assessment platform
          </p>
          <h1 className="text-4xl font-semibold tracking-tight md:text-5xl">Create. Assess. Evaluate.</h1>
          <p className="mt-4 max-w-lg text-lg text-muted-foreground">
            A flexible assessment platform for managing question papers, assessments, learners and evaluation from one place.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link href="/login" className={buttonVariants({ size: "lg", className: "h-10 px-4" })}>
              Sign in to Platform <ArrowRight />
            </Link>
            <a href="#how-it-works" className={buttonVariants({ variant: "outline", size: "lg", className: "h-10 px-4" })}>
              Explore Platform
            </a>
          </div>
        </div>
        <WorkflowVisual />
      </section>

      <section id="features" className="scroll-mt-20 border-t bg-canvas">
        <div className="mx-auto max-w-6xl px-4 py-16 md:px-6">
          <h2 className="text-2xl font-semibold tracking-tight">Features</h2>
          <p className="mt-2 max-w-2xl text-muted-foreground">Everything an academic operations team needs to run assessments at scale.</p>
          <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((f) => (
              <div key={f.title} className="rounded-xl border bg-card p-5">
                <f.icon className="size-5 text-primary" aria-hidden />
                <h3 className="mt-3 text-sm font-semibold">{f.title}</h3>
                <p className="mt-1 text-sm text-muted-foreground">{f.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="how-it-works" className="scroll-mt-20 border-t">
        <div className="mx-auto max-w-6xl px-4 py-16 md:px-6">
          <h2 className="text-2xl font-semibold tracking-tight">How it works</h2>
          <ol className="mt-8 grid gap-6 md:grid-cols-3">
            {[
              ["Prepare the paper", "Import a question paper from Excel, Word or PDF. Configure sections and attempt rules, review flagged questions and approve it."],
              ["Schedule the assessment", "Choose the batch, select the question paper, set duration, negative marking and the window, then schedule."],
              ["Evaluate and publish", "Objective answers are scored automatically; examiners mark subjective answers. Review and publish results."],
            ].map(([t, b], i) => (
              <li key={t} className="rounded-xl border p-5">
                <span className="text-sm font-semibold text-primary tabular-nums">Step {i + 1}</span>
                <h3 className="mt-1 font-semibold">{t}</h3>
                <p className="mt-2 text-sm text-muted-foreground">{b}</p>
              </li>
            ))}
          </ol>
          <div className="mt-8">
            <Link href="/login" className={buttonVariants({ size: "lg", className: "h-10 px-4" })}>
              Sign in to try the workflow <ArrowRight />
            </Link>
          </div>
        </div>
      </section>

      <section id="support" className="scroll-mt-20 border-t bg-canvas">
        <div className="mx-auto grid max-w-6xl gap-6 px-4 py-16 md:grid-cols-2 md:px-6">
          <div>
            <h2 className="text-2xl font-semibold tracking-tight">Support</h2>
            <p className="mt-2 text-muted-foreground">The academic operations team supports administrators, examiners and learners.</p>
          </div>
          <div className="rounded-xl border bg-card p-5 text-sm">
            <p className="font-medium">Assessment operations desk</p>
            <p className="mt-1 text-muted-foreground">support@example.com</p>
            <p className="text-muted-foreground">Monday–Saturday, 9:00 AM – 7:00 PM IST</p>
          </div>
        </div>
      </section>

      <footer className="border-t">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2 px-4 py-6 text-xs text-muted-foreground md:px-6">
          <span>© Assessment Platform — internal use</span>
        </div>
      </footer>
    </div>
  );
}
