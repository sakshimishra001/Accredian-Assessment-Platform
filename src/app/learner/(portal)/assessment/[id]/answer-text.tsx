import type { ComponentProps } from "react";
import { Textarea } from "@/components/ui/textarea";

/**
 * The learner's written-answer field. Spell check is the browser's own (the `spellcheck`
 * attribute), switched on or off by the assessment's setting from the server: misspellings are only
 * marked, and text changes only if the learner picks a suggestion. Auto-correct is always off (iOS
 * Safari would otherwise rewrite words on its own) — the application never changes what was typed.
 */
export function AnswerText({ spellCheck, ...props }: Omit<ComponentProps<"textarea">, "spellCheck" | "autoCorrect"> & { spellCheck: boolean }) {
  return <Textarea {...props} spellCheck={spellCheck} autoCorrect="off" />;
}
