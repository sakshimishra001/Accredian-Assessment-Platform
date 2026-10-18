import { afterEach, describe, expect, it, vi } from "vitest";
import { responseConfigSchema } from "@/lib/validation/files";
import { setPasswordSchema, staffAccountSchema } from "@/lib/validation/staff";
import { parseEnv } from "@/server/env";
import { NoMalwareScanner, TestMalwareScanner } from "@/server/files/scan";
import { validateUpload } from "@/server/files/validate";
import { recentlyRecorded, resetRecentlyRecorded } from "@/server/security/recent";
import { devDatabaseProblem } from "../../scripts/db-guard";

const DB = "postgresql://app:s3cr3t-value@db.internal:5432/assessment_prod";
const PROD_OK = {
  NODE_ENV: "production",
  DATABASE_URL: DB,
  APP_URL: "https://assessments.example.org",
  STORAGE_DRIVER: "local",
  STORAGE_LOCAL_DIR: "/var/lib/assessment/files",
  EMAIL_PROVIDER: "outbox",
  MALWARE_SCANNER: "none",
  TRUST_PROXY: "true",
};

describe("environment validation", () => {
  it("gives development safe local defaults", () => {
    const e = parseEnv({ NODE_ENV: "development", DATABASE_URL: "postgresql://u:p@localhost:5432/assessment_dev" });
    expect(e).toMatchObject({ STORAGE_DRIVER: "local", EMAIL_PROVIDER: "outbox", MALWARE_SCANNER: "none", APP_URL: "http://localhost:3000", TRUST_PROXY: false });
    expect(e).toMatchObject({ STAFF_SESSION_IDLE_MINUTES: 30, STAFF_SESSION_MAX_HOURS: 12, LEARNER_SESSION_IDLE_MINUTES: 120, RESULTS_ACCESS_DAYS: 30 });
  });

  it("fails closed in production when anything is left to a default — naming each setting, never a value", () => {
    let message = "";
    try {
      parseEnv({ NODE_ENV: "production", DATABASE_URL: DB });
    } catch (err) {
      message = (err as Error).message;
    }
    for (const key of ["APP_URL", "STORAGE_DRIVER", "EMAIL_PROVIDER", "MALWARE_SCANNER", "TRUST_PROXY"]) expect(message).toContain(key);
    expect(message).not.toContain("s3cr3t-value");
    expect(() => parseEnv({ NODE_ENV: "production" })).toThrow(/DATABASE_URL is required/);
  });

  it("refuses development and test-only settings in production", () => {
    expect(() => parseEnv({ ...PROD_OK, APP_URL: "http://localhost:3000" })).toThrow(/https[\s\S]*localhost/);
    expect(() => parseEnv({ ...PROD_OK, STORAGE_DRIVER: "memory" })).toThrow(/tests only/);
    expect(() => parseEnv({ ...PROD_OK, STORAGE_LOCAL_DIR: undefined })).toThrow(/STORAGE_LOCAL_DIR/);
    expect(() => parseEnv({ ...PROD_OK, STORAGE_LOCAL_DIR: "relative/dir" })).toThrow(/absolute/);
    expect(() => parseEnv({ ...PROD_OK, EMAIL_PROVIDER: "test" })).toThrow(/EMAIL_PROVIDER "test"/);
    expect(() => parseEnv({ ...PROD_OK, MALWARE_SCANNER: "test" })).toThrow(/MALWARE_SCANNER "test"/);
    expect(() => parseEnv({ ...PROD_OK, DATABASE_URL: "postgresql://u:p@db:5432/assessment_test" })).toThrow(/test database/);
    expect(parseEnv(PROD_OK)).toMatchObject({ APP_URL: PROD_OK.APP_URL, TRUST_PROXY: true, EMAIL_PROVIDER: "outbox" });
  });

  it("`next build` isn't a server start: production rules are checked when the server starts instead", () => {
    expect(() => parseEnv({ NODE_ENV: "production", DATABASE_URL: DB, NEXT_PHASE: "phase-production-build" })).not.toThrow();
    expect(() => parseEnv({ NODE_ENV: "production", DATABASE_URL: DB, NEXT_PHASE: "phase-production-server" })).toThrow(/Invalid production configuration/);
  });
});

describe("development-only database commands", () => {
  it("refuse production, non-development databases and a missing URL", () => {
    expect(devDatabaseProblem("reset", { NODE_ENV: "production", DATABASE_URL: "postgresql://u:p@h/assessment_dev" })).toMatch(/production/);
    expect(devDatabaseProblem("reset", { DATABASE_URL: DB })).toMatch(/doesn't look like a development database/);
    expect(devDatabaseProblem("reset", { DATABASE_URL: DB })).not.toContain("s3cr3t-value");
    expect(devDatabaseProblem("reset", {})).toMatch(/not set/);
    expect(devDatabaseProblem("reset", { DATABASE_URL: "postgresql://u:p@localhost:5432/assessment_dev" })).toBeNull();
    expect(devDatabaseProblem("reset", { DATABASE_URL: "postgresql://u:p@localhost:5432/assessment_test" })).toBeNull();
    expect(devDatabaseProblem("reset", { DATABASE_URL: "postgresql://u:p@localhost:5432/scratch", ALLOW_DEV_DB_COMMAND: "scratch" })).toBeNull();
  });
});

describe("file security", () => {
  const rules = (allowed: string[]) => ({ allowed, maxBytes: 1024 * 1024 });
  const OLE = Buffer.from("d0cf11e0a1b11ae1000000", "hex");
  const docx = (extra = "") => Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from(`[Content_Types].xml word/document.xml ${extra}`)]);

  it("no longer accepts SVG or legacy binary Office files, even where an old setting allows them", () => {
    for (const ext of ["doc", "xls", "ppt"]) expect(() => validateUpload({ name: `old.${ext}`, data: OLE }, rules([ext]))).toThrow(/no longer accepted/);
    expect(() => validateUpload({ name: "logo.svg", data: Buffer.from("<svg></svg>") }, rules(["svg"]))).toThrow(/no longer accepted/);
  });

  it("refuses Office files carrying macros or ActiveX controls", () => {
    expect(validateUpload({ name: "ok.docx", data: docx() }, rules(["docx"])).extension).toBe("docx");
    expect(() => validateUpload({ name: "m.docx", data: docx("word/vbaProject.bin") }, rules(["docx"]))).toThrow(/macros/);
    expect(() => validateUpload({ name: "a.docx", data: docx("word/activeX/activeX1.xml") }, rules(["docx"]))).toThrow(/macros or ActiveX/);
  });

  it("drops retired types from older response settings instead of failing the save", () => {
    expect(responseConfigSchema.parse({ type: "FILE", allowedFileTypes: ["doc", "docx", "SVG", "pdf"] }).allowedFileTypes).toEqual(["docx", "pdf"]);
    expect(responseConfigSchema.safeParse({ type: "FILE", allowedFileTypes: ["doc"] }).success).toBe(false);
  });

  it("scanner: 'none' never reports a file as clean; the test scanner flags the EICAR test file", async () => {
    expect(await new NoMalwareScanner().scan()).toEqual({ status: "NOT_SCANNED" });
    const eicar = Buffer.from("X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*");
    expect(await new TestMalwareScanner().scan(eicar)).toMatchObject({ status: "INFECTED", signature: "EICAR-Test-File" });
    expect(await new TestMalwareScanner().scan(Buffer.from("a,b\n1,2\n"))).toEqual({ status: "CLEAN", scanner: "test" });
  });
});

describe("staff accounts", () => {
  it("only staff roles can be created", () => {
    expect(staffAccountSchema.safeParse({ name: "Asha", email: "A@X.org", role: "ADMIN" }).data).toEqual({ name: "Asha", email: "a@x.org", role: "ADMIN" });
    expect(staffAccountSchema.safeParse({ name: "Asha", email: "a@x.org", role: "LEARNER" }).success).toBe(false);
  });

  it("password rules: long enough, within bcrypt's 72 bytes, confirmed", () => {
    const ok = { token: "t".repeat(43), password: "correct horse battery", confirm: "correct horse battery" };
    expect(setPasswordSchema.safeParse(ok).success).toBe(true);
    expect(setPasswordSchema.safeParse({ ...ok, password: "short", confirm: "short" }).success).toBe(false);
    const long = "é".repeat(40); // 80 bytes
    expect(setPasswordSchema.safeParse({ ...ok, password: long, confirm: long }).success).toBe(false);
    expect(setPasswordSchema.safeParse({ ...ok, confirm: "something else" }).error?.issues[0].path).toEqual(["confirm"]);
  });
});

describe("audit de-duplication", () => {
  it("records a key once per window", () => {
    resetRecentlyRecorded();
    expect(recentlyRecorded("k", 1000, 0)).toBe(false);
    expect(recentlyRecorded("k", 1000, 999)).toBe(true);
    expect(recentlyRecorded("k", 1000, 1000)).toBe(false);
  });
});

describe("session cookie", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("uses the __Host- prefix in production only", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.resetModules();
    expect((await import("@/lib/auth/constants")).SESSION_COOKIE_NAME).toBe("__Host-aap_session");
    vi.stubEnv("NODE_ENV", "development");
    vi.resetModules();
    expect((await import("@/lib/auth/constants")).SESSION_COOKIE_NAME).toBe("aap_session");
  });
});
