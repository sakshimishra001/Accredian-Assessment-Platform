import { describe, expect, it } from "vitest";
import { markupToHtml, renderTemplate, unknownVariables } from "@/lib/communication/templates";
import { extensionOf } from "@/lib/files/types";
import { assessmentCommunicationSchema, templateSchema, templateUpdateSchema } from "@/lib/validation/communication";
import { responseConfigSchema } from "@/lib/validation/files";
import { sanitizeFileName, validateUpload } from "@/server/files/validate";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const rules = (allowed: string[], maxBytes = 1024) => ({ allowed, maxBytes });

describe("file validation", () => {
  it("accepts a file whose content matches its extension and decides the MIME type itself", () => {
    expect(validateUpload({ name: "chart.PNG", data: PNG }, rules(["png"]))).toMatchObject({ fileName: "chart.PNG", extension: "png", mimeType: "image/png", sizeBytes: PNG.length });
    expect(validateUpload({ name: "data.csv", data: Buffer.from("a,b\n1,2\n") }, rules(["csv"]))).toMatchObject({ mimeType: "text/csv" });
  });

  it("rejects disallowed types, disguised content, empty and oversized files", () => {
    expect(() => validateUpload({ name: "x.exe", data: Buffer.from("MZ") }, rules(["png"]))).toThrow(/isn’t accepted/);
    expect(() => validateUpload({ name: "x.png", data: Buffer.from("not a png") }, rules(["png"]))).toThrow(/doesn’t match/);
    expect(() => validateUpload({ name: "x.docx", data: Buffer.from("PK\u0003\u0004 not office") }, rules(["docx"]))).toThrow(/doesn’t match/);
    expect(() => validateUpload({ name: "x.csv", data: Buffer.from([0x61, 0x00, 0x62]) }, rules(["csv"]))).toThrow(/doesn’t match/);
    // SVG is no longer accepted at all, even where an old question setting still lists it.
    expect(() => validateUpload({ name: "x.svg", data: Buffer.from("<svg><script>alert(1)</script></svg>") }, rules(["svg"]))).toThrow(/no longer accepted/);
    expect(() => validateUpload({ name: "x.csv", data: Buffer.alloc(0) }, rules(["csv"]))).toThrow(/empty/);
    expect(() => validateUpload({ name: "x.csv", data: Buffer.alloc(2048, "a") }, rules(["csv"]))).toThrow(/too large/);
  });

  it("never keeps a path in the file name", () => {
    expect(sanitizeFileName("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFileName("C:\\Users\\me\\report<1>.pdf")).toBe("report1.pdf");
    expect(sanitizeFileName("\u0000")).toBe("file");
    expect(extensionOf("archive.tar.GZ")).toBe("gz");
    expect(extensionOf("noext")).toBe("");
  });

  it("validates the learner response configuration", () => {
    expect(responseConfigSchema.parse({ type: "TEXT", allowedFileTypes: ["pdf"], fileRequired: true })).toMatchObject({ type: "TEXT", allowedFileTypes: [], fileRequired: false });
    expect(responseConfigSchema.parse({ type: "FILE", allowedFileTypes: ["PDF", "pdf", "csv"], maxFileSizeMb: "10", maxFiles: "2", fileRequired: true })).toEqual({
      type: "FILE",
      allowedFileTypes: ["pdf", "csv"],
      maxFileSizeMb: 10,
      maxFiles: 2,
      fileRequired: true,
    });
    expect(responseConfigSchema.safeParse({ type: "FILE", allowedFileTypes: [] }).success).toBe(false);
    expect(responseConfigSchema.safeParse({ type: "FILE", allowedFileTypes: ["exe"] }).success).toBe(false);
    expect(responseConfigSchema.safeParse({ type: "FILE", allowedFileTypes: ["pdf"], maxFileSizeMb: 500 }).success).toBe(false);
  });
});

describe("templates", () => {
  const valid = { name: "Exam Assignment", type: "ASSESSMENT", subject: "Hi {{learner_name}}", body: "Body", fromName: "A", fromEmail: " Team@Example.com " };

  it("accepts allowlisted variables only", () => {
    expect(unknownVariables("{{learner_name}} {{ assessment_name }} {{password}} {{password}}")).toEqual(["password"]);
    expect(templateSchema.parse(valid)).toMatchObject({ status: "DRAFT", trigger: "", fromEmail: "team@example.com", replyTo: null });
    expect(templateSchema.safeParse({ ...valid, body: "{{exam_code}}" }).error?.issues[0].message).toBe("Unknown variable: {{exam_code}}");
  });

  it("partial updates don't reset omitted fields to their defaults", () => {
    expect(templateUpdateSchema.parse({ subject: "New" })).toEqual({ subject: "New" });
  });

  it("renders variables as text and escapes them in HTML", () => {
    const r = renderTemplate({ subject: "Hello\n{{learner_name}}", body: "Dear **{{learner_name}}**,\n\n- one\n- two\n\n[Open]({{assessment_link}})" }, { learner_name: "<b>Ana</b>", assessment_link: "https://x.test/a?b=1&c=2" });
    expect(r.subject).toBe("Hello <b>Ana</b>");
    expect(r.html).toContain("<strong>&lt;b&gt;Ana&lt;/b&gt;</strong>");
    expect(r.html).toContain("<ul><li>one</li><li>two</li></ul>");
    expect(r.html).toContain('<a href="https://x.test/a?b=1&amp;c=2">Open</a>');
    expect(r.text).toContain("Open (https://x.test/a?b=1&c=2)");
    expect(markupToHtml('[x](javascript:alert("1"))')).toContain('href="#"');
    expect(markupToHtml('<img src=x onerror="alert(1)">')).toBe("<p>&lt;img src=x onerror=&quot;alert(1)&quot;&gt;</p>");
  });

  it("validates the assessment communication settings shape", () => {
    const event = { enabled: false, templateId: "" };
    const parsed = assessmentCommunicationSchema.parse({ ASSIGNMENT: event, REMINDER: { ...event, reminderTiming: "H2" }, STARTING_SOON: event, RESCHEDULED: event, CANCELLED: event, RESULT_PUBLISHED: event });
    expect(parsed.REMINDER).toMatchObject({ reminderTiming: "H2", templateId: null, overrideSubject: null });
    expect(assessmentCommunicationSchema.safeParse({ ASSIGNMENT: event }).success).toBe(false);
  });
});
