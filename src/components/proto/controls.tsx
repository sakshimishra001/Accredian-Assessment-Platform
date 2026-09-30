"use client";

import { useState, type ReactNode } from "react";
import { Check, ChevronLeft, ChevronRight, Search } from "lucide-react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Switch } from "@/components/ui/switch";

export function Field({
  label,
  htmlFor,
  error,
  hint,
  required,
  children,
  className,
}: {
  label: ReactNode;
  htmlFor?: string;
  error?: string | null;
  hint?: ReactNode;
  required?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("grid content-start gap-1.5", className)}>
      <Label htmlFor={htmlFor} className="text-sm">
        {label}
        {required ? <span className="text-destructive">*</span> : null}
      </Label>
      {children}
      {error ? (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

export function SelectField({
  value,
  onChange,
  options,
  placeholder,
  className,
  id,
  ariaLabel,
  invalid,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  placeholder?: string;
  className?: string;
  id?: string;
  ariaLabel?: string;
  invalid?: boolean;
  disabled?: boolean;
}) {
  return (
    <NativeSelect
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={cn("w-full", className)}
      aria-label={ariaLabel}
      aria-invalid={invalid || undefined}
      disabled={disabled}
    >
      {placeholder !== undefined ? <NativeSelectOption value="">{placeholder}</NativeSelectOption> : null}
      {options.map((o) => (
        <NativeSelectOption key={o.value} value={o.value}>
          {o.label}
        </NativeSelectOption>
      ))}
    </NativeSelect>
  );
}

export function SearchInput({ value, onChange, placeholder, className }: { value: string; onChange: (v: string) => void; placeholder: string; className?: string }) {
  return (
    <div className={cn("relative", className)}>
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
      <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className="pl-8" aria-label={placeholder} />
    </div>
  );
}

export function ToggleRow({
  label,
  description,
  checked,
  onChange,
  disabled,
  children,
}: {
  label: ReactNode;
  description?: ReactNode;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className="py-3 first:pt-0 last:pb-0">
      <label className={cn("flex items-start justify-between gap-4", disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer")}>
        <span>
          <span className="block text-sm font-medium">{label}</span>
          {description ? <span className="mt-0.5 block text-xs text-muted-foreground">{description}</span> : null}
        </span>
        <Switch checked={checked} onCheckedChange={(v) => onChange(Boolean(v))} disabled={disabled} className="mt-0.5" aria-label={typeof label === "string" ? label : undefined} />
      </label>
      {children}
    </div>
  );
}

export function Stepper({
  steps,
  current,
  onStepClick,
  maxReached,
}: {
  steps: string[];
  current: number;
  onStepClick?: (i: number) => void;
  maxReached?: number;
}) {
  return (
    <ol className="flex flex-wrap items-center gap-x-2 gap-y-3" aria-label="Progress">
      {steps.map((label, i) => {
        const done = i < current;
        const active = i === current;
        const reachable = onStepClick && i <= (maxReached ?? current);
        const content = (
          <>
            <span
              className={cn(
                "flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ring-1 ring-inset",
                done && "bg-primary text-primary-foreground ring-primary",
                active && "bg-primary/10 text-primary ring-primary",
                !done && !active && "bg-background text-muted-foreground ring-border",
              )}
            >
              {done ? <Check className="size-3.5" /> : i + 1}
            </span>
            <span className={cn("text-sm whitespace-nowrap", active ? "font-medium text-foreground" : "text-muted-foreground")}>{label}</span>
          </>
        );
        return (
          <li key={label} className="flex items-center gap-2">
            {reachable && !active ? (
              <button type="button" onClick={() => onStepClick(i)} className="flex items-center gap-2 rounded-md hover:opacity-80">
                {content}
              </button>
            ) : (
              <span className="flex items-center gap-2" aria-current={active ? "step" : undefined}>
                {content}
              </span>
            )}
            {i < steps.length - 1 ? <span className="mx-1 hidden h-px w-8 bg-border sm:block" aria-hidden /> : null}
          </li>
        );
      })}
    </ol>
  );
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive,
  onConfirm,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
  children?: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        {children}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {cancelLabel}
          </Button>
          <Button
            variant={destructive ? "destructive" : "default"}
            onClick={() => {
              onConfirm();
              onOpenChange(false);
            }}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Client-side pagination for mock tables. */
export function usePagination<T>(rows: T[], pageSize = 10) {
  const [page, setPage] = useState(1);
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const current = Math.min(page, pageCount);
  const slice = rows.slice((current - 1) * pageSize, current * pageSize);
  return { page: current, pageCount, setPage, slice, total: rows.length, pageSize };
}

export function Pagination({
  page,
  pageCount,
  setPage,
  total,
  pageSize,
}: {
  page: number;
  pageCount: number;
  setPage: (p: number) => void;
  total: number;
  pageSize: number;
}) {
  if (total === 0) return null;
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return (
    <div className="flex items-center justify-between gap-2 border-t px-4 py-2.5 text-xs text-muted-foreground">
      <span>
        Showing <span className="font-medium text-foreground">{from}</span>–<span className="font-medium text-foreground">{to}</span> of{" "}
        <span className="font-medium text-foreground">{total.toLocaleString("en-IN")}</span>
      </span>
      <span className="flex items-center gap-1">
        <Button variant="ghost" size="icon-sm" onClick={() => setPage(page - 1)} disabled={page <= 1} aria-label="Previous page">
          <ChevronLeft />
        </Button>
        <span className="px-1">
          Page {page} of {pageCount}
        </span>
        <Button variant="ghost" size="icon-sm" onClick={() => setPage(page + 1)} disabled={page >= pageCount} aria-label="Next page">
          <ChevronRight />
        </Button>
      </span>
    </div>
  );
}
