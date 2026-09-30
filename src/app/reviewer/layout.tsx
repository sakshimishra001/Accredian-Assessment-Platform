"use client";

import { AppShell } from "@/components/proto/app-shell";

export default function Layout({ children }: { children: React.ReactNode }) {
  return <AppShell role="reviewer">{children}</AppShell>;
}
