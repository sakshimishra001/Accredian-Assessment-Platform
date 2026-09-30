"use client";

import { useEffect, useRef, useState } from "react";
import { CheckCircle2, Loader2, Upload, UserPlus } from "lucide-react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { newId } from "@/prototype/store";
import type { Learner } from "@/prototype/types";
import { Field } from "./controls";

const NAMES = ["Ishaan Malhotra", "Tara Krishnan", "Dev Anand", "Mira Joshi", "Parth Shah", "Zoya Khan", "Rehan Das", "Anika Bhat", "Kunal Verma", "Nisha Rao", "Aryan Gill", "Pallavi Sen"];

export function makeLearners(batchId: string, count: number, offset = 0): Learner[] {
  return Array.from({ length: count }, (_, i) => {
    const name = NAMES[(i + offset) % NAMES.length];
    const n = offset + i + 1;
    return {
      id: newId("l"),
      name,
      email: `${name.toLowerCase().replace(/\s+/g, ".")}${n}@learner.example.com`,
      batchId,
      status: "Invited" as const,
    };
  });
}

/** Add learners to a batch — either by simulated CSV upload or one at a time. */
export function ImportLearnersDialog({
  open,
  onOpenChange,
  batchName,
  onImport,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  batchName: string;
  onImport: (mode: "csv" | "single", single?: { name: string; email: string }) => void;
}) {
  const [mode, setMode] = useState<"csv" | "single">("csv");
  const [phase, setPhase] = useState<"idle" | "running" | "done">("idle");
  const [progress, setProgress] = useState(0);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearInterval(timer.current);
    },
    [],
  );

  // Reset the form whenever the dialog closes, so it opens fresh next time.
  const handleOpenChange = (o: boolean) => {
    if (!o) {
      if (timer.current) clearInterval(timer.current);
      setPhase("idle");
      setProgress(0);
      setName("");
      setEmail("");
      setErrors({});
    }
    onOpenChange(o);
  };

  function runCsv() {
    setPhase("running");
    setProgress(8);
    timer.current = setInterval(() => {
      setProgress((p) => {
        if (p >= 100) {
          if (timer.current) clearInterval(timer.current);
          setPhase("done");
          return 100;
        }
        return p + 23;
      });
    }, 350);
  }

  function addSingle() {
    const e: Record<string, string> = {};
    if (name.trim().length < 2) e.name = "Enter the learner’s name.";
    if (!/^\S+@\S+\.\S+$/.test(email)) e.email = "Enter a valid email address.";
    setErrors(e);
    if (Object.keys(e).length) return;
    onImport("single", { name: name.trim(), email: email.trim().toLowerCase() });
    handleOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Import learners · {batchName}</DialogTitle>
          <DialogDescription>Learners receive an invitation email to set up their account (simulated).</DialogDescription>
        </DialogHeader>
        <div className="flex gap-1 rounded-lg bg-muted p-1" role="tablist">
          {(
            [
              ["csv", "Upload CSV"],
              ["single", "Add one learner"],
            ] as const
          ).map(([k, l]) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={mode === k}
              onClick={() => setMode(k)}
              className={cn("flex-1 rounded-md px-2 py-1 text-sm", mode === k ? "bg-background font-medium shadow-sm" : "text-muted-foreground")}
            >
              {l}
            </button>
          ))}
        </div>

        {mode === "csv" ? (
          phase === "idle" ? (
            <div className="flex flex-col items-center rounded-lg border-2 border-dashed px-4 py-8 text-center">
              <Upload className="size-6 text-muted-foreground" />
              <p className="mt-2 text-sm font-medium">learners.csv</p>
              <p className="text-xs text-muted-foreground">Columns: Name, Email, Phone (optional)</p>
              <Button className="mt-4" size="sm" onClick={runCsv}>
                Upload sample CSV
              </Button>
            </div>
          ) : phase === "running" ? (
            <div className="grid gap-2 py-4" aria-live="polite">
              <p className="flex items-center gap-2 text-sm">
                <Loader2 className="size-4 animate-spin text-primary" /> Validating rows…
              </p>
              <Progress value={Math.min(progress, 100)} />
            </div>
          ) : (
            <div className="grid gap-2 rounded-lg bg-emerald-50 px-4 py-3 text-sm text-emerald-900 ring-1 ring-emerald-200 ring-inset">
              <p className="flex items-center gap-2 font-medium">
                <CheckCircle2 className="size-4" /> 12 learners ready to import
              </p>
              <p className="text-emerald-900/80">0 duplicates · 0 invalid emails</p>
            </div>
          )
        ) : (
          <div className="grid gap-3">
            <Field label="Full name" htmlFor="ln" error={errors.name}>
              <Input id="ln" value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Email" htmlFor="le" error={errors.email}>
              <Input id="le" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </Field>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          {mode === "csv" ? (
            <Button
              disabled={phase !== "done"}
              onClick={() => {
                onImport("csv");
                handleOpenChange(false);
              }}
            >
              Import 12 learners
            </Button>
          ) : (
            <Button onClick={addSingle}>
              <UserPlus /> Add learner
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
