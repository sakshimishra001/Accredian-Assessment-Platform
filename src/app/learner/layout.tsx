"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { AppShell } from "@/components/proto/app-shell";
import { DEMO_USERS, useProto, useProtoActions } from "@/prototype/store";

export default function LearnerLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { session } = useProto();
  const { signIn } = useProtoActions();
  const inExam = pathname.startsWith("/learner/assessment/");

  // The exam screen renders without the app shell, so it ensures the demo session itself.
  useEffect(() => {
    if (inExam && (!session || session.role !== "learner")) signIn(DEMO_USERS.learner);
  }, [inExam, session, signIn]);

  if (inExam) return <>{children}</>;
  return <AppShell role="learner">{children}</AppShell>;
}
