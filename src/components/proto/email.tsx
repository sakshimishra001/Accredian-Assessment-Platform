"use client";

import { Fragment, useImperativeHandle, useRef, type ReactNode, type Ref } from "react";
import { Bold, Braces, Italic, Link2, List, Pilcrow } from "lucide-react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { VARIABLE_GROUPS, resolveVariables, type VariableValues } from "@/lib/communication/templates";

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function inline(text: string): ReactNode[] {
  // **bold**, _italic_, [label](url) — links are inert in previews.
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|_[^_]+_|\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("**")) out.push(<strong key={k++}>{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith("_")) out.push(<em key={k++}>{tok.slice(1, -1)}</em>);
    else {
      const label = tok.slice(1, tok.indexOf("]"));
      out.push(
        <span key={k++} className="text-primary underline underline-offset-2">
          {label}
        </span>,
      );
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Renders template markup. A paragraph that is only a link becomes a call-to-action button. */
export function EmailBody({ text, className }: { text: string; className?: string }) {
  const blocks = text.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  return (
    <div className={cn("grid gap-3 text-sm leading-relaxed", className)}>
      {blocks.map((b, i) => {
        const lines = b.split("\n");
        if (lines.every((l) => l.trim().startsWith("- "))) {
          return (
            <ul key={i} className="grid list-disc gap-1 pl-5">
              {lines.map((l, j) => (
                <li key={j}>{inline(l.trim().slice(2))}</li>
              ))}
            </ul>
          );
        }
        const cta = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(b);
        if (cta) {
          return (
            <div key={i}>
              <span className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground">{cta[1]}</span>
            </div>
          );
        }
        return (
          <p key={i}>
            {lines.map((l, j) => (
              <Fragment key={j}>
                {j > 0 ? <br /> : null}
                {inline(l)}
              </Fragment>
            ))}
          </p>
        );
      })}
    </div>
  );
}

export interface EmailContent {
  subject: string;
  body: string;
  fromName: string;
  fromEmail: string;
}

export function EmailPreviewDialog({
  email,
  values,
  to,
  onClose,
  title = "Email preview",
  context,
}: {
  email: EmailContent | null;
  values: VariableValues;
  /** e.g. "sakshi@example.com" or "48 learners in …" */
  to: string;
  onClose: () => void;
  title?: string;
  context?: ReactNode;
}) {
  return (
    <Dialog open={email !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        {email ? (
          <>
            <DialogHeader>
              <DialogTitle>{title}</DialogTitle>
              <DialogDescription>Variables are filled with {context ? "this assessment’s" : "sample"} values. Nothing is sent.</DialogDescription>
            </DialogHeader>
            {context}
            <div className="overflow-hidden rounded-lg border">
              <dl className="grid grid-cols-[4.5rem_1fr] gap-x-3 gap-y-1.5 border-b bg-muted/40 px-4 py-3 text-sm">
                <dt className="text-muted-foreground">From</dt>
                <dd>
                  <span className="font-medium">{email.fromName}</span> <span className="text-muted-foreground">&lt;{email.fromEmail}&gt;</span>
                </dd>
                <dt className="text-muted-foreground">To</dt>
                <dd>{to}</dd>
                <dt className="text-muted-foreground">Subject</dt>
                <dd className="font-medium">{resolveVariables(email.subject, values)}</dd>
              </dl>
              <div className="max-h-[50vh] overflow-auto bg-background px-6 py-5">
                <EmailBody text={resolveVariables(email.body, values)} />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={onClose}>
                Close
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Mock rich-text editor with variables
// ---------------------------------------------------------------------------

type FieldKey = "subject" | "body";

export interface EditorHandle {
  /** Insert text (e.g. a variable) at the cursor of the last-focused field. */
  insert: (text: string) => void;
}

export function InsertVariableMenu({ onInsert, label = "Insert Variable" }: { onInsert: (v: string) => void; label?: string }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="inline-flex h-7 items-center gap-1.5 rounded-md border bg-background px-2 text-xs font-medium hover:bg-muted" aria-label="Insert Variable">
        <Braces className="size-3.5" /> {label}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-80 w-60 overflow-auto">
        {VARIABLE_GROUPS.map((g, i) => (
          <div key={g.label}>
            {i > 0 ? <DropdownMenuSeparator /> : null}
            <DropdownMenuGroup>
              <DropdownMenuLabel>{g.label}</DropdownMenuLabel>
              {g.vars.map((v) => (
                <DropdownMenuItem key={v} onClick={() => onInsert(`{{${v}}}`)} className="font-mono text-xs">
                  {`{{${v}}}`}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function spliceInto(el: HTMLInputElement | HTMLTextAreaElement | null, value: string, make: (selected: string) => string, set: (v: string) => void) {
  const start = el?.selectionStart ?? value.length;
  const end = el?.selectionEnd ?? value.length;
  const insert = make(value.slice(start, end));
  set(value.slice(0, start) + insert + value.slice(end));
  requestAnimationFrame(() => {
    el?.focus();
    const pos = start + insert.length;
    el?.setSelectionRange(pos, pos);
  });
}

/**
 * Subject + body editor. Formatting applies to the body; Insert Variable goes into whichever
 * field was focused last (body by default).
 */
export function TemplateContentEditor({
  subject,
  body,
  onSubject,
  onBody,
  handle,
}: {
  subject: string;
  body: string;
  onSubject: (v: string) => void;
  onBody: (v: string) => void;
  /** Lets a parent-owned variables panel insert into the same field. */
  handle?: Ref<EditorHandle>;
}) {
  const subjectRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const focus = useRef<FieldKey>("body");

  const insertVariable = (v: string) =>
    focus.current === "subject" ? spliceInto(subjectRef.current, subject, () => v, onSubject) : spliceInto(bodyRef.current, body, () => v, onBody);

  useImperativeHandle(handle, () => ({ insert: insertVariable }));

  const format = (kind: "bold" | "italic" | "bullets" | "link" | "paragraph") => {
    focus.current = "body";
    const make: Record<typeof kind, (sel: string) => string> = {
      bold: (sel) => `**${sel || "bold text"}**`,
      italic: (sel) => `_${sel || "italic text"}_`,
      bullets: (sel) => (sel || "List item").split("\n").map((l) => `- ${l.replace(/^- /, "")}`).join("\n"),
      link: (sel) => `[${sel || "Link text"}](https://)`,
      paragraph: () => "\n\n",
    };
    spliceInto(bodyRef.current, body, make[kind], onBody);
  };

  const tool = (kind: Parameters<typeof format>[0], Icon: typeof Bold, label: string) => (
    <Button type="button" variant="ghost" size="icon-sm" onClick={() => format(kind)} aria-label={label} title={label}>
      <Icon />
    </Button>
  );

  return (
    <div className="grid gap-4">
      <div className="grid gap-1.5">
        <div className="flex items-center justify-between gap-2">
          <label htmlFor="tpl-subject" className="text-sm font-medium">
            Subject Line
          </label>
        </div>
        <Input
          id="tpl-subject"
          ref={subjectRef}
          value={subject}
          onFocus={() => (focus.current = "subject")}
          onChange={(e) => onSubject(e.target.value)}
          aria-invalid={!subject.trim() || undefined}
        />
      </div>
      <div className="grid gap-1.5">
        <label htmlFor="tpl-body" className="text-sm font-medium">
          Email Body
        </label>
        <div className="overflow-hidden rounded-lg border focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/30">
          <div className="flex flex-wrap items-center gap-0.5 border-b bg-muted/40 px-1.5 py-1" role="toolbar" aria-label="Formatting">
            {tool("bold", Bold, "Bold")}
            {tool("italic", Italic, "Italic")}
            {tool("bullets", List, "Bullets")}
            {tool("link", Link2, "Link")}
            {tool("paragraph", Pilcrow, "Paragraph")}
            <span className="mx-1 h-4 w-px bg-border" aria-hidden />
            <InsertVariableMenu onInsert={insertVariable} />
          </div>
          <Textarea
            id="tpl-body"
            ref={bodyRef}
            rows={14}
            value={body}
            onFocus={() => (focus.current = "body")}
            onChange={(e) => onBody(e.target.value)}
            className="rounded-none border-0 font-mono text-[13px] leading-relaxed focus-visible:ring-0"
          />
        </div>
        <p className="text-xs text-muted-foreground">Formatting: **bold**, _italic_, “- ” for bullets, [text](link). A line with only a link becomes a button.</p>
      </div>
    </div>
  );
}

export function VariablesPanel({ onInsert }: { onInsert: (v: string) => void }) {
  return (
    <div className="grid gap-3 text-sm">
      {VARIABLE_GROUPS.map((g) => (
        <div key={g.label}>
          <p className="mb-1 text-xs font-medium text-muted-foreground">{g.label}</p>
          <div className="flex flex-wrap gap-1">
            {g.vars.map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => onInsert(`{{${v}}}`)}
                className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground hover:bg-accent hover:text-accent-foreground"
                title="Insert at cursor"
              >
                {`{{${v}}}`}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
