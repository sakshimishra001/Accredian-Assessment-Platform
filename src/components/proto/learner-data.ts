"use client";

import { useProto } from "@/prototype/store";
import type { Assessment } from "@/prototype/types";

/** The demo learner's batch and the assessments visible to them. */
export function useLearnerAssessments() {
  const s = useProto();
  const me = s.learners.find((l) => l.email === "learner@example.com") ?? s.learners[0];
  const mine = s.assessments.filter((a) => a.batchId === me.batchId && a.status !== "Draft");
  // Prototype: the next scheduled paper opens early so the attempt flow can be demonstrated.
  const demo = mine.filter((a) => a.status === "Scheduled").sort((a, b) => a.schedule.start.localeCompare(b.schedule.start))[0];
  const active: (Assessment & { demo?: boolean })[] = [
    ...mine.filter((a) => a.status === "Active"),
    ...(demo ? [{ ...demo, demo: true }] : []),
  ];
  const upcoming = mine.filter((a) => a.status === "Scheduled" && a.id !== demo?.id);
  const completed = mine.filter((a) => ["Completed", "Evaluation", "Published"].includes(a.status));
  return { me, active, upcoming, completed, demoId: demo?.id };
}
