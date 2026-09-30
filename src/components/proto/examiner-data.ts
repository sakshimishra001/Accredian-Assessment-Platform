"use client";

import { DEMO_USERS, useProto } from "@/prototype/store";

/** Evaluations for the signed-in demo examiner. */
export function useMyEvaluations() {
  const s = useProto();
  const email = s.session?.role === "examiner" ? s.session.email : DEMO_USERS.examiner.email;
  const me = s.examiners.find((e) => e.email === email) ?? s.examiners[0];
  const mine = s.evaluations.filter((e) => e.examinerId === me.id);
  return {
    me,
    pending: mine.filter((e) => e.status !== "Completed"),
    completed: mine.filter((e) => e.status === "Completed"),
    assigned: s.assessments.filter((a) => a.examinerIds.includes(me.id)),
  };
}
