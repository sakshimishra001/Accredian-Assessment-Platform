"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { Copy, Eye, Mail, Pencil, Power, PowerOff } from "lucide-react";
import { cn } from "cn";
import { ConfirmDialog, Pagination, SearchInput, SelectField, usePagination } from "@/components/proto/controls";
import { EmailPreviewDialog, type EmailContent } from "@/components/proto/email";
import { DetailList, EmptyState, PageHeader } from "@/components/proto/page";
import { RowActions } from "@/components/proto/row-actions";
import { StatusBadge } from "@/components/proto/status-badge";
import { withSuspense } from "@/components/proto/suspense-page";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SAMPLE_VALUES, valuesForAssessment } from "@/prototype/lib/communication";
import { formatDate, formatDateTime, formatNumber } from "@/prototype/lib/format";
import { newId, useLookups, useProto, useProtoActions } from "@/prototype/store";
import { useToast } from "@/prototype/toast";
import type { CommHistoryEntry, CommTemplate, CommType } from "@/prototype/types";

const TYPES: CommType[] = ["Assessment", "Reminder", "Assessment Update", "Results"];

function CommunicationPage() {
  const params = useSearchParams();
  const [tab, setTab] = useState<"templates" | "history">(params.get("tab") === "history" ? "history" : "templates");
  const s = useProto();

  return (
    <>
      <PageHeader title="Communication" description="Manage assessment communication templates, notifications, reminders and learner emails." />
      <div className="mb-4 flex gap-1 border-b" role="tablist">
        {(
          [
            ["templates", `Templates`, s.templates.length],
            ["history", "Communication History", s.commHistory.length],
          ] as const
        ).map(([k, l, n]) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={tab === k}
            onClick={() => setTab(k)}
            className={cn("-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm", tab === k ? "border-primary font-medium" : "border-transparent text-muted-foreground hover:text-foreground")}
          >
            {l}
            <span className="rounded-full bg-muted px-1.5 text-[11px] text-muted-foreground tabular-nums">{n}</span>
          </button>
        ))}
      </div>
      {tab === "templates" ? <TemplatesTab /> : <HistoryTab />}
    </>
  );
}

function TemplatesTab() {
  const s = useProto();
  const router = useRouter();
  const toast = useToast();
  const { saveTemplate, updateTemplate } = useProtoActions();
  const [q, setQ] = useState("");
  const [type, setType] = useState("");
  const [status, setStatus] = useState("");
  const [preview, setPreview] = useState<CommTemplate | null>(null);
  const [disabling, setDisabling] = useState<CommTemplate | null>(null);

  const rows = s.templates
    .filter((t) => (type ? t.type === type : true))
    .filter((t) => (status ? t.status === status : true))
    .filter((t) => (q.trim() ? `${t.name} ${t.subject} ${t.trigger}`.toLowerCase().includes(q.trim().toLowerCase()) : true));

  const inUse = (id: string) => s.assessments.filter((a) => a.communication && Object.values(a.communication).some((v) => typeof v === "object" && v && "templateId" in v && v.templateId === id && v.enabled)).length;

  return (
    <>
      <div className="mb-4 grid gap-2 sm:grid-cols-[1fr_12rem_10rem]">
        <SearchInput value={q} onChange={setQ} placeholder="Search templates…" />
        <SelectField value={type} onChange={setType} placeholder="All types" ariaLabel="Communication type" options={TYPES.map((t) => ({ value: t, label: t }))} />
        <SelectField value={status} onChange={setStatus} placeholder="Any status" ariaLabel="Status" options={["Active", "Draft", "Disabled"].map((t) => ({ value: t, label: t }))} />
      </div>
      <div className="rounded-lg border bg-card">
        {rows.length === 0 ? (
          <EmptyState className="m-4" icon={Mail} title="No templates match" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Template Name</TableHead>
                <TableHead>Communication Type</TableHead>
                <TableHead>Trigger</TableHead>
                <TableHead>Subject</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Last Updated</TableHead>
                <TableHead className="w-12 pr-4">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((t) => (
                <TableRow key={t.id} className="cursor-pointer" onClick={() => router.push(`/admin/communication/templates/${t.id}`)}>
                  <TableCell className="pl-4 font-medium">{t.name}</TableCell>
                  <TableCell className="text-muted-foreground">{t.type}</TableCell>
                  <TableCell className="text-muted-foreground">{t.trigger}</TableCell>
                  <TableCell className="max-w-72 truncate font-mono text-xs text-muted-foreground">{t.subject}</TableCell>
                  <TableCell>
                    <StatusBadge status={t.status} />
                  </TableCell>
                  <TableCell className="text-muted-foreground">{formatDate(t.updatedAt)}</TableCell>
                  <TableCell className="pr-4 text-right" onClick={(e) => e.stopPropagation()}>
                    <RowActions
                      label={`Actions for ${t.name}`}
                      actions={[
                        { label: "Edit", icon: Pencil, onSelect: () => router.push(`/admin/communication/templates/${t.id}`) },
                        { label: "Preview", icon: Eye, onSelect: () => setPreview(t) },
                        {
                          label: "Duplicate",
                          icon: Copy,
                          onSelect: () => {
                            const copy = { ...t, id: newId("t"), name: `${t.name} (Copy)`, status: "Draft" as const, updatedAt: new Date().toISOString() };
                            saveTemplate(copy);
                            toast.success("Template duplicated", `“${copy.name}” was created as a draft.`);
                          },
                        },
                        t.status === "Active"
                          ? { label: "Disable", icon: PowerOff, destructive: true, separatorBefore: true, onSelect: () => setDisabling(t) }
                          : {
                              label: "Enable",
                              icon: Power,
                              separatorBefore: true,
                              onSelect: () => {
                                updateTemplate(t.id, { status: "Active" });
                                toast.success("Template enabled", t.name);
                              },
                            },
                      ]}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
      <p className="mt-3 text-xs text-muted-foreground">Templates define standard wording. Each assessment chooses which template to use, who receives it and when — in its Communication step.</p>

      <EmailPreviewDialog email={preview} values={SAMPLE_VALUES} to={SAMPLE_VALUES.learner_email} onClose={() => setPreview(null)} title={preview ? `Preview · ${preview.name}` : undefined} />
      <ConfirmDialog
        open={disabling !== null}
        onOpenChange={(o) => !o && setDisabling(null)}
        title={`Disable “${disabling?.name}”?`}
        description={
          disabling && inUse(disabling.id)
            ? `${inUse(disabling.id)} assessment(s) currently use this template. They will need another template before publishing.`
            : "Disabled templates can’t be selected for assessments until they are enabled again."
        }
        confirmLabel="Disable template"
        destructive
        onConfirm={() => {
          if (!disabling) return;
          updateTemplate(disabling.id, { status: "Disabled" });
          toast.success("Template disabled", disabling.name);
        }}
      />
    </>
  );
}

function HistoryTab() {
  const s = useProto();
  const lookup = useLookups();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [viewing, setViewing] = useState<CommHistoryEntry | null>(null);
  const [previewing, setPreviewing] = useState<CommHistoryEntry | null>(null);

  const rows = useMemo(
    () =>
      [...s.commHistory]
        .filter((h) => (status ? h.status === status : true))
        .filter((h) => (q.trim() ? `${h.communication} ${h.assessmentName} ${h.batchName}`.toLowerCase().includes(q.trim().toLowerCase()) : true))
        .sort((a, b) => b.date.localeCompare(a.date)),
    [s.commHistory, status, q],
  );
  const pager = usePagination(rows, 10);

  const templateFor = (h: CommHistoryEntry) => s.templates.find((t) => t.id === h.templateId);
  const valuesFor = (h: CommHistoryEntry) => {
    const a = h.assessmentId ? lookup.assessment(h.assessmentId) : undefined;
    if (!a) return SAMPLE_VALUES;
    const batch = lookup.batch(a.batchId);
    const learner = batch ? lookup.learner(batch.learnerIds[0]) : undefined;
    return valuesForAssessment({
      name: a.name,
      courseName: lookup.course(a.courseId)?.name,
      batchName: batch?.name,
      start: a.schedule.start,
      end: a.schedule.end,
      durationMinutes: a.durationMinutes,
      learnerName: learner?.name,
      learnerEmail: learner?.email,
      supportEmail: s.settings.supportEmail,
      companyName: s.settings.organizationName,
    });
  };
  const previewEmail: EmailContent | null = previewing ? (templateFor(previewing) ?? null) : null;

  return (
    <>
      <div className="mb-4 grid gap-2 sm:grid-cols-[1fr_10rem]">
        <SearchInput value={q} onChange={setQ} placeholder="Search communication, assessment or batch…" />
        <SelectField value={status} onChange={setStatus} placeholder="Any status" ariaLabel="Status" options={["Draft", "Scheduled", "Sent", "Failed"].map((t) => ({ value: t, label: t }))} />
      </div>
      <div className="rounded-lg border bg-card">
        {rows.length === 0 ? (
          <EmptyState className="m-4" icon={Mail} title="No communication matches" />
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">Date</TableHead>
                  <TableHead>Communication</TableHead>
                  <TableHead>Assessment</TableHead>
                  <TableHead>Batch</TableHead>
                  <TableHead className="text-right">Recipients</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="pr-4 text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pager.slice.map((h) => (
                  <TableRow key={h.id}>
                    <TableCell className="pl-4 text-muted-foreground">{formatDateTime(h.date)}</TableCell>
                    <TableCell className="font-medium">{h.communication}</TableCell>
                    <TableCell className="max-w-64 truncate text-muted-foreground">{h.assessmentName}</TableCell>
                    <TableCell className="max-w-52 truncate text-muted-foreground">{h.batchName}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatNumber(h.recipients)}</TableCell>
                    <TableCell>
                      <StatusBadge status={h.status} />
                    </TableCell>
                    <TableCell className="pr-4 text-right">
                      <Button variant="ghost" size="sm" onClick={() => setViewing(h)}>
                        View
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setPreviewing(h)} disabled={!templateFor(h)}>
                        Preview
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <Pagination {...pager} />
          </>
        )}
      </div>
      <p className="mt-3 text-xs text-muted-foreground">Prototype — statuses are simulated. No email is sent.</p>

      <Dialog open={viewing !== null} onOpenChange={(o) => !o && setViewing(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{viewing?.communication}</DialogTitle>
            <DialogDescription>{viewing?.subject}</DialogDescription>
          </DialogHeader>
          {viewing ? (
            <DetailList
              className="grid-cols-[6.5rem_1fr]"
              items={[
                ["Status", <StatusBadge key="s" status={viewing.status} />],
                [viewing.status === "Sent" ? "Sent" : viewing.status === "Scheduled" ? "Scheduled for" : "Date", `${formatDateTime(viewing.date)} IST`],
                ["Assessment", viewing.assessmentName],
                ["Batch", viewing.batchName],
                ["Recipients", `${formatNumber(viewing.recipients)} learners`],
                ["Template", templateFor(viewing)?.name ?? "—"],
                ...(viewing.status === "Failed" ? ([["Reason", "3 addresses bounced (simulated)."]] as [string, string][]) : []),
              ]}
            />
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setViewing(null)}>
              Close
            </Button>
            <Button
              onClick={() => {
                setPreviewing(viewing);
                setViewing(null);
              }}
              disabled={!viewing || !templateFor(viewing)}
            >
              <Eye /> Preview email
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <EmailPreviewDialog
        email={previewEmail}
        values={previewing ? valuesFor(previewing) : SAMPLE_VALUES}
        to={previewing ? `${formatNumber(previewing.recipients)} learners in ${previewing.batchName}` : ""}
        onClose={() => setPreviewing(null)}
        title={previewing ? `${previewing.communication} · ${previewing.assessmentName}` : undefined}
      />
    </>
  );
}

export default withSuspense(CommunicationPage);
