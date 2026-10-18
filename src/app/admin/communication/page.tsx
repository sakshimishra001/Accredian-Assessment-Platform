import type { Metadata } from "next";
import { Role } from "@/lib/auth/rbac";
import { requireRole } from "@/server/auth/guards";
import { listCommunicationLog, listTemplates } from "@/server/services/communication";
import { CommunicationView } from "./communication-view";

export const metadata: Metadata = { title: "Communication" };

/** Templates and communication history, from PostgreSQL (admin only). */
export default async function CommunicationPage({ searchParams }: PageProps<"/admin/communication">) {
  const actor = await requireRole(Role.ADMIN);
  const { tab } = await searchParams;
  const [templates, history] = await Promise.all([listTemplates(actor), listCommunicationLog(actor)]);
  return <CommunicationView templates={templates} history={history} initialTab={tab === "history" ? "history" : "templates"} />;
}
