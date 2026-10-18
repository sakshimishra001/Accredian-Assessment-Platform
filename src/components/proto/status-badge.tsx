import { cn } from "cn";

type Tone = "neutral" | "blue" | "green" | "amber" | "purple" | "teal" | "red" | "solid-green" | "indigo";

const TONES: Record<Tone, string> = {
  neutral: "bg-muted text-muted-foreground ring-border",
  blue: "bg-blue-50 text-blue-700 ring-blue-200",
  indigo: "bg-indigo-50 text-indigo-700 ring-indigo-200",
  green: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  "solid-green": "bg-emerald-600 text-white ring-emerald-600",
  amber: "bg-amber-50 text-amber-800 ring-amber-200",
  purple: "bg-violet-50 text-violet-700 ring-violet-200",
  teal: "bg-teal-50 text-teal-700 ring-teal-200",
  red: "bg-red-50 text-red-700 ring-red-200",
};

/** Every status string used in the prototype maps to one tone, so badges are consistent everywhere. */
const STATUS_TONE: Record<string, Tone> = {
  // assessments
  Draft: "neutral",
  Scheduled: "blue",
  Active: "green",
  Paused: "amber",
  Locked: "red",
  Live: "green",
  Completed: "teal",
  Ended: "teal",
  "Result ready": "indigo",
  "Not delivered": "amber",
  Evaluation: "purple",
  Published: "solid-green",
  // papers
  Processing: "indigo",
  "Needs Review": "amber",
  "In review": "amber",
  Approved: "green",
  Archived: "neutral",
  // batches / people
  Upcoming: "blue",
  Invited: "amber",
  Inactive: "neutral",
  Suspended: "red",
  // results & evaluations
  Passed: "green",
  Failed: "red",
  "Pending evaluation": "purple",
  Absent: "neutral",
  Pending: "amber",
  "In progress": "blue",
  // communication
  Disabled: "neutral",
  Sent: "green",
  Queued: "blue",
  Sending: "blue",
  // accounts
  "No password": "amber",
  // generic
  "Not configured": "neutral",
  Valid: "green",
};

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  const tone = STATUS_TONE[status] ?? "neutral";
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center gap-1 rounded-full px-2 text-xs font-medium whitespace-nowrap ring-1 ring-inset",
        TONES[tone],
        className,
      )}
    >
      {tone !== "solid-green" ? <span className="size-1.5 rounded-full bg-current opacity-70" aria-hidden /> : null}
      {status}
    </span>
  );
}

export function Tag({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex h-5 items-center rounded-md bg-muted px-1.5 text-xs font-medium text-muted-foreground", className)}>
      {children}
    </span>
  );
}
