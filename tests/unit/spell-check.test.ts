import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AnswerText } from "@/app/learner/(portal)/assessment/[id]/answer-text";

/*
 * Spell check: the browser's own `spellcheck` attribute on the learner's written-answer field.
 * (React writes it as `spellCheck`; HTML attribute names are case-insensitive, hence the /i.)
 */

const render = (spellCheck: boolean, value = "Teh recieve") => renderToStaticMarkup(createElement(AnswerText, { spellCheck, value, readOnly: true, "aria-label": "Answer" }));

describe("written-answer field", () => {
  it("1: spell check off → spellcheck=\"false\"", () => {
    expect(render(false)).toMatch(/<textarea[^>]*spellcheck="false"/i);
  });

  it("2: spell check on → spellcheck=\"true\"", () => {
    expect(render(true)).toMatch(/<textarea[^>]*spellcheck="true"/i);
  });

  it("never auto-corrects and never changes the text: auto-correct is off and the value is rendered exactly as typed", () => {
    for (const on of [true, false]) {
      const html = render(on);
      expect(html).toMatch(/autocorrect="off"/i);
      expect(html).toContain(">Teh recieve</textarea>");
    }
  });

  it("3: every written answer in the exam (short, long, and the text part of text + file) uses this field with the assessment's setting", () => {
    const dir = path.resolve(__dirname, "../../src/app/learner/(portal)/assessment/[id]");
    const screen = readFileSync(path.join(dir, "exam-screen.tsx"), "utf8");
    expect(screen).toMatch(/<AnswerText\s+spellCheck=\{assessment\.spellCheck\}/);
    // No other text-entry element anywhere in the learner exam that could bypass the setting.
    for (const f of readdirSync(dir).filter((n) => /\.tsx$/.test(n) && n !== "answer-text.tsx")) {
      expect(/<Textarea|<textarea|contentEditable/.test(readFileSync(path.join(dir, f), "utf8")), f).toBe(false);
    }
  });
});
