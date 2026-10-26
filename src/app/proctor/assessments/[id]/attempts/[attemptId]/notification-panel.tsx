"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Send } from "lucide-react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { canSendNotification, checkNotificationMessage, NOTIFICATION_MAX_LENGTH, QUICK_NOTIFICATIONS } from "@/lib/proctoring/notifications";
import { useToast } from "@/prototype/toast";
import { sendProctorNotificationAction } from "@/server/actions/proctor";

/**
 * Send a one-way notification to this learner (phase 8): pick a quick message or write one (3–300
 * characters), then Send. The learner sees it in their exam without being interrupted; it never
 * affects the attempt. The server checks everything again — who may send, that the attempt belongs to
 * this assessment and is running, and the message.
 */
export function NotificationPanel({ assessmentId, attemptId, learnerName }: { assessmentId: string; attemptId: string; learnerName: string }) {
  const router = useRouter();
  const toast = useToast();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const length = draft.trim().length;
  const check = checkNotificationMessage(draft);

  function send() {
    if (!canSendNotification(draft, pending)) {
      if (!check.ok) setError(check.error);
      return;
    }
    const message = draft;
    setError(null);
    startTransition(async () => {
      const result = await sendProctorNotificationAction(assessmentId, attemptId, message);
      if (!result.ok) {
        setError(result.fieldErrors?.message?.[0] ?? result.error);
        toast.error("Notification not sent", result.error);
        return;
      }
      setDraft("");
      toast.success("Notification sent", `${learnerName} will see it in their exam.`);
      router.refresh();
    });
  }

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap gap-2" role="group" aria-label="Quick messages">
        {QUICK_NOTIFICATIONS.map((q) => (
          <Button
            key={q}
            type="button"
            size="sm"
            variant={draft === q ? "default" : "outline"}
            aria-pressed={draft === q}
            disabled={pending}
            onClick={() => {
              setDraft(q);
              setError(null);
            }}
          >
            {q}
          </Button>
        ))}
      </div>
      <div className="grid gap-1.5">
        <label htmlFor="notification-message" className="text-sm font-medium">
          Message to {learnerName}
        </label>
        <Textarea
          id="notification-message"
          value={draft}
          maxLength={NOTIFICATION_MAX_LENGTH}
          rows={3}
          disabled={pending}
          placeholder="Choose a quick message above or write your own."
          aria-invalid={!!error || undefined}
          aria-describedby="notification-help"
          onChange={(e) => {
            setDraft(e.target.value);
            setError(null);
          }}
        />
        <div id="notification-help" className="flex items-center justify-between gap-3 text-xs">
          <span className={cn(error ? "text-red-700" : "text-muted-foreground")} role={error ? "alert" : undefined}>
            {error ?? "One-way: the learner can acknowledge it but can’t reply. It doesn’t affect the attempt."}
          </span>
          <span className={cn("tabular-nums", length > NOTIFICATION_MAX_LENGTH ? "text-red-700" : "text-muted-foreground")} data-char-count={length}>
            {length}/{NOTIFICATION_MAX_LENGTH}
          </span>
        </div>
      </div>
      <div className="flex justify-end">
        <Button type="button" onClick={send} disabled={!canSendNotification(draft, pending)}>
          <Send /> {pending ? "Sending…" : "Send Notification"}
        </Button>
      </div>
    </div>
  );
}
