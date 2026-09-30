"use client";

import { AppShell } from "@/components/proto/app-shell";

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return <AppShell role="admin">{children}</AppShell>;
}
