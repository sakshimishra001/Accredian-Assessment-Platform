"use client";

import { usePathname } from "next/navigation";
import { AppShell } from "@/components/proto/app-shell";

/** The exam screen renders full-screen, without the app shell. */
export function LearnerChrome({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  if (pathname.startsWith("/learner/assessment/")) return <>{children}</>;
  return <AppShell role="learner">{children}</AppShell>;
}
