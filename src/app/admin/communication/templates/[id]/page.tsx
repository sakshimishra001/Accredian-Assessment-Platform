import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Role } from "@/lib/auth/rbac";
import { NotFoundError } from "@/lib/errors";
import { requireRole } from "@/server/auth/guards";
import { getTemplate } from "@/server/services/communication";
import { TemplateEditor } from "./template-editor";

export const metadata: Metadata = { title: "Communication template" };

/** Edit a communication template from PostgreSQL ("new" creates one). */
export default async function TemplatePage({ params }: PageProps<"/admin/communication/templates/[id]">) {
  const actor = await requireRole(Role.ADMIN);
  const { id } = await params;
  if (id === "new") return <TemplateEditor template={null} />;
  const template = await getTemplate(actor, id).catch((err) => {
    if (err instanceof NotFoundError) notFound();
    throw err;
  });
  return <TemplateEditor template={template} />;
}
