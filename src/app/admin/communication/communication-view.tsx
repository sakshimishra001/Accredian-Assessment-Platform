"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { Copy, Eye, Mail, Pencil, Plus, Power } from "lucide-react";
import { cn } from "cn";
import { ConfirmDialog, Pagination, SearchInput, SelectField, usePagination } from "@/components/proto/controls";
import { EmailPreviewDialog } from "@/components/proto/email";
import { EmptyState, PageHeader } from "@/components/proto/page";
import { RowActions } from "@/components/proto/row-actions";
import { StatusBadge } from "@/components/proto/status-badge";
import { buttonVariants } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { COMMUNICATION_EVENTS, COMMUNICATION_TYPE_LABEL, DELIVERY_STATUS_LABEL, SAMPLE_VALUES, TEMPLATE_STATUS_LABEL } from "@/lib/communication/templates";
import { formatDateTime } from "@/prototype/lib/format";
import { useToast } from "@/prototype/toast";
import { duplicateTemplateAction, updateTemplateAction } from "@/server/actions/communication";
import type { listCommunicationLog, listTemplates } from "@/server/services/communication";

type Template = Awaited<ReturnType<typeof listTemplates>>[number];
type LogRow = Awaited<ReturnType<typeof listCommunicationLog>>[number];

const EVENT_LABEL = Object.fromEntries(COMMUNICATION_EVENTS.map((e) => [e.key, e.label])) as Record<string, string>;
const iso = (d: Date) => d.toISOString();

export function CommunicationView({ templates, history, initialTab }: { templates: Template[]; history: LogRow[]; initialTab: "templates" | "history" }) {
  const [tab, setTab] = useState(initialTab);
  return (
    <>
      <PageHeader
        title="Communication"
        description="Email templates and the emails assessments have produced."
        actions={
          <Link href="/admin/communication/templates/new" className={buttonVariants()}>
            <Plus /> New Template
          </Link>
        }
      />
      <p className="mb-4 flex items-center gap-2 rounded-lg bg-amber-50 px-4 py-2.5 text-sm text-amber-900 ring-1 ring-amber-200 ring-inset">
        <Mail className="size-4 shrink-0" /> No email service is connected yet. Emails are recorded below as “not delivered” — nothing is sent.
      </p>
      <div className="mb-4 flex gap-1 border-b" role="tablist">
        {(
          [
            ["templates", `Templates (${templates.length})`],
            ["history", `Communication History (${history.length})`],
          ] as const
        ).map(([k, l]) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={tab === k}
            onClick={() => setTab(k)}
            className={cn("-mb-px border-b-2 px-3 py-2 text-sm", tab === k ? "border-primary font-medium" : "border-transparent text-muted-foreground hover:text-foreground")}
          >
            {l}
          </button>
        ))}
      </div>
      {tab === "templates" ? <TemplatesTab templates={templates} /> : <HistoryTab history={history} />}
    </>
  );
}

function TemplatesTab({ templates }: { templates: Template[] }) {
  const router = useRouter();
  const toast = useToast();
  const [q, setQ] = useState("");
  const [type, setType] = useState("");
  const [status, setStatus] = useState("");
  const [preview, setPreview] = useState<Template | null>(null);
  const [disabling, setDisabling] = useState<Template | null>(null);
  const [pending, startTransition] = useTransition();
  const term = q.trim().toLowerCase();
  const rows = templates.filter((t) => (!type || t.type === type) && (!status || t.status === status) && (!term || `${t.name} ${t.subject}`.toLowerCase().includes(term)));

  const setStatusOf = (t: Template, next: Template["status"]) =>
    startTransition(async () => {
      const r = await updateTemplateAction(t.id, { status: next });
      if (!r.ok) return toast.error("Couldn’t change the status", r.error);
      toast.success(next === "ACTIVE" ? "Template enabled" : "Template disabled", t.name);
      router.refresh();
    });

  return (
    <>
      <div className="mb-4 grid gap-2 sm:grid-cols-[minmax(14rem,1fr)_repeat(2,minmax(0,11rem))]">
        <SearchInput value={q} onChange={setQ} placeholder="Search templates…" />
        <SelectField value={type} onChange={setType} placeholder="All types" ariaLabel="Type" options={Object.entries(COMMUNICATION_TYPE_LABEL).map(([value, label]) => ({ value, label }))} />
        <SelectField value={status} onChange={setStatus} placeholder="Any status" ariaLabel="Status" options={Object.entries(TEMPLATE_STATUS_LABEL).map(([value, label]) => ({ value, label }))} />
      </div>
      <div className="rounded-lg border bg-card">
        {rows.length === 0 ? (
          <EmptyState
            className="m-4"
            icon={Mail}
            title={templates.length ? "No templates match" : "No templates yet"}
            description={templates.length ? "Try clearing a filter." : "Create the emails assessments send — e.g. Exam Assignment, Exam Reminder, Result Published."}
            action={
              <Link href="/admin/communication/templates/new" className={buttonVariants()}>
                New Template
              </Link>
            }
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Template</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Trigger</TableHead>
                <TableHead className="text-right">In use</TableHead>
                <TableHead>Updated</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-12 pr-4">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((t) => (
                <TableRow key={t.id}>
                  <TableCell className="pl-4">
                    <Link href={`/admin/communication/templates/${t.id}`} className="font-medium hover:underline">
                      {t.name}
                    </Link>
                    <div className="max-w-80 truncate text-xs text-muted-foreground">{t.subject}</div>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{COMMUNICATION_TYPE_LABEL[t.type]}</TableCell>
                  <TableCell className="text-muted-foreground">{t.trigger || "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">{t.usedBy}</TableCell>
                  <TableCell className="text-muted-foreground">{formatDateTime(iso(t.updatedAt))}</TableCell>
                  <TableCell>
                    <StatusBadge status={TEMPLATE_STATUS_LABEL[t.status]} />
                  </TableCell>
                  <TableCell className="pr-4 text-right">
                    <RowActions
                      label={`Actions for ${t.name}`}
                      actions={[
                        { label: "Edit", icon: Pencil, onSelect: () => router.push(`/admin/communication/templates/${t.id}`) },
                        { label: "Preview", icon: Eye, onSelect: () => setPreview(t) },
                        {
                          label: "Duplicate",
                          icon: Copy,
                          onSelect: () =>
                            startTransition(async () => {
                              const r = await duplicateTemplateAction(t.id);
                              if (!r.ok) return toast.error("Couldn’t duplicate", r.error);
                              toast.success("Template duplicated", `“${r.data!.name}” was created as a draft.`);
                              router.refresh();
                            }),
                        },
                        t.status === "ACTIVE"
                          ? { label: "Disable", icon: Power, onSelect: () => setDisabling(t), destructive: true, separatorBefore: true, disabled: pending }
                          : { label: "Enable", icon: Power, onSelect: () => setStatusOf(t, "ACTIVE"), separatorBefore: true, disabled: pending },
                      ]}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
      <EmailPreviewDialog email={preview} values={SAMPLE_VALUES} to={SAMPLE_VALUES.learner_email} onClose={() => setPreview(null)} title={`Preview · ${preview?.name ?? ""}`} />
      <ConfirmDialog
        open={disabling !== null}
        onOpenChange={(o) => !o && setDisabling(null)}
        title={`Disable ${disabling?.name}?`}
        description="Disabled templates can’t be chosen for assessments. A template that is switched on in an assessment can’t be disabled."
        confirmLabel="Disable"
        destructive
        onConfirm={() => disabling && setStatusOf(disabling, "DISABLED")}
      />
    </>
  );
}

const HISTORY_BADGE: Record<LogRow["status"], string> = { PENDING: "Queued", SENDING: "Sending", SENT: "Sent", FAILED: "Failed", NOT_DELIVERED: "Not delivered" };

function HistoryTab({ history }: { history: LogRow[] }) {
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [viewing, setViewing] = useState<LogRow | null>(null);
  const rows = useMemo(() => {
    const term = q.trim().toLowerCase();
    return history.filter((h) => (!status || h.status === status) && (!term || `${h.recipientEmail} ${h.subject} ${h.assessment?.name ?? ""}`.toLowerCase().includes(term)));
  }, [history, q, status]);
  const pager = usePagination(rows, 15);

  return (
    <>
      <div className="mb-4 grid gap-2 sm:grid-cols-[minmax(14rem,1fr)_minmax(0,14rem)]">
        <SearchInput value={q} onChange={setQ} placeholder="Search recipient, subject or assessment…" />
        <SelectField value={status} onChange={setStatus} placeholder="Any status" ariaLabel="Delivery status" options={Object.entries(DELIVERY_STATUS_LABEL).map(([value, label]) => ({ value, label }))} />
      </div>
      <div className="rounded-lg border bg-card">
        {rows.length === 0 ? (
          <EmptyState className="m-4" icon={Mail} title="No communications yet" description="Emails appear here when assessments are published, rescheduled, cancelled or their results are published." />
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">Date</TableHead>
                  <TableHead>Communication</TableHead>
                  <TableHead>Assessment</TableHead>
                  <TableHead>Recipient</TableHead>
                  <TableHead className="pr-4">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pager.slice.map((h) => (
                  <TableRow key={h.id} className="cursor-pointer" onClick={() => setViewing(h)}>
                    <TableCell className="pl-4 text-muted-foreground">{formatDateTime(iso(h.createdAt))}</TableCell>
                    <TableCell>
                      <div className="font-medium">{h.event ? EVENT_LABEL[h.event] : "Email"}</div>
                      <div className="text-xs text-muted-foreground">{h.template?.name ?? "Template removed"}</div>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {h.assessment ? (
                        <Link href={`/admin/assessments/${h.assessment.id}`} className="hover:underline" onClick={(e) => e.stopPropagation()}>
                          {h.assessment.name}
                        </Link>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{h.recipientEmail}</TableCell>
                    <TableCell className="pr-4">
                      <StatusBadge status={HISTORY_BADGE[h.status]} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <Pagination {...pager} />
          </>
        )}
      </div>
      <Dialog open={viewing !== null} onOpenChange={(o) => !o && setViewing(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{viewing?.subject}</DialogTitle>
            <DialogDescription>
              {viewing ? `${viewing.event ? EVENT_LABEL[viewing.event] : "Email"} · ${formatDateTime(iso(viewing.createdAt))} IST` : ""}
            </DialogDescription>
          </DialogHeader>
          {viewing ? (
            <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-2 text-sm">
              <dt className="text-muted-foreground">To</dt>
              <dd>{viewing.recipientEmail}</dd>
              <dt className="text-muted-foreground">Assessment</dt>
              <dd>{viewing.assessment ? `${viewing.assessment.name}${viewing.assessment.batch ? ` · ${viewing.assessment.batch.name}` : ""}` : "—"}</dd>
              <dt className="text-muted-foreground">Template</dt>
              <dd>{viewing.template?.name ?? "—"}</dd>
              <dt className="text-muted-foreground">Status</dt>
              <dd>{DELIVERY_STATUS_LABEL[viewing.status]}</dd>
              <dt className="text-muted-foreground">Provider</dt>
              <dd>{viewing.provider ?? "—"}</dd>
              {viewing.error ? (
                <>
                  <dt className="text-muted-foreground">Details</dt>
                  <dd>{viewing.error}</dd>
                </>
              ) : null}
            </dl>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
