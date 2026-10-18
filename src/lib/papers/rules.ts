import { SectionAttemptRule } from "@/generated/prisma/enums";

export { SectionAttemptRule };

/*
 * Question papers need no review or approval: a saved paper is usable as soon as it is complete
 * (see paperReadinessIssues). The legacy status column (DRAFT / IN_REVIEW / APPROVED) is kept for
 * history but no longer decides anything.
 *
 * The one lock: a paper used by an assessment can't change, because its sections, attempt rules,
 * case passages and materials are part of that assessment (and of its scoring and results). To
 * change such a paper, create a new version.
 */

/** A paper can be edited until an assessment uses it. */
export function canEditPaper(assessmentCount: number): boolean {
  return assessmentCount === 0;
}

export const PAPER_IN_USE_MESSAGE = "This question paper is used by an assessment, so it can’t be changed. Create a new version to make changes.";

/** What the library shows for a paper: in use by an assessment, ready to use, or incomplete. */
export function paperUsageLabel(p: { inUse: boolean; ready: boolean }): string {
  return p.inUse ? "In use" : p.ready ? "Ready" : "Incomplete";
}

export const ATTEMPT_RULE_LABEL: Record<SectionAttemptRule, string> = {
  ALL: "Attempt all",
  ANY_N: "Attempt any N",
  EXACTLY_N: "Attempt exactly N",
  UP_TO_N: "Attempt up to N",
  BEST_N: "Best N count",
};

export function ruleNeedsCount(rule: SectionAttemptRule): boolean {
  return rule !== SectionAttemptRule.ALL;
}

/** "Attempt any 5 of 8", "Best 5 of 7 count", … (for review screens and learner instructions). */
export function attemptRuleText(rule: SectionAttemptRule, count: number | null, itemCount: number): string {
  const n = count ?? 0;
  switch (rule) {
    case SectionAttemptRule.ALL:
      return `Attempt all ${itemCount}`;
    case SectionAttemptRule.ANY_N:
      return `Attempt any ${n} of ${itemCount}`;
    case SectionAttemptRule.EXACTLY_N:
      return `Attempt exactly ${n} of ${itemCount}`;
    case SectionAttemptRule.UP_TO_N:
      return `Attempt up to ${n} of ${itemCount}`;
    case SectionAttemptRule.BEST_N:
      return `Best ${n} of ${itemCount} count`;
  }
}

/**
 * Maximum marks a section can contribute. ALL: every top-level item. N-rules: the N highest-marked
 * items (the most a learner could score). A group's marks are the sum of its sub-questions.
 * Configuration only — scoring itself belongs to the attempt/scoring engine.
 */
export function sectionMaxMarks(rule: SectionAttemptRule, count: number | null, itemMarks: number[]): number {
  if (rule === SectionAttemptRule.ALL || count == null) return round2(itemMarks.reduce((a, b) => a + b, 0));
  return round2([...itemMarks].sort((a, b) => b - a).slice(0, count).reduce((a, b) => a + b, 0));
}

export const round2 = (n: number) => Math.round(n * 100) / 100;

export interface ReadinessSection {
  title: string;
  attemptRule: SectionAttemptRule;
  attemptCount: number | null;
  items: { kind: "question" | "group"; marks: number; childCount: number; number: string }[];
}

/**
 * What makes a paper unusable in an assessment (no sections, a section with no questions, an
 * impossible attempt rule, a case without sub-questions, a question without marks). Empty when the
 * paper is complete — then it can be selected in the Assessment Builder straight away.
 */
export function paperReadinessIssues(sections: ReadinessSection[]): string[] {
  const issues: string[] = [];
  if (sections.length === 0) issues.push("Add at least one section.");
  for (const s of sections) {
    if (s.items.length === 0) issues.push(`“${s.title}” has no questions.`);
    if (ruleNeedsCount(s.attemptRule) && s.attemptCount != null && s.attemptCount > s.items.length) {
      issues.push(`“${s.title}” asks for ${s.attemptCount} questions but has only ${s.items.length}.`);
    }
    for (const item of s.items) {
      if (item.kind === "group" && item.childCount === 0) issues.push(`Q${item.number} (case/passage) has no sub-questions.`);
      if (item.kind === "question" && item.marks <= 0) issues.push(`Q${item.number} has no marks.`);
    }
  }
  return issues;
}
