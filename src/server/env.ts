import { z } from "zod";

/*
 * Server configuration. Development and tests get safe local defaults; production fails closed:
 * every setting that decides where data goes (URL, storage, email, malware scanning, proxy trust)
 * must be set explicitly, and test-only drivers are refused. Values are never echoed in errors.
 */

const minutes = (def: number, max: number) => z.coerce.number().int().min(5).max(max).default(def);
const hours = (def: number) => z.coerce.number().int().min(1).max(72).default(def);

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z
    .string({ error: "DATABASE_URL is required. Copy .env.example to .env and set it." })
    .regex(/^postgres(ql)?:\/\/.+/, "DATABASE_URL must be a postgresql:// connection string"),

  /** Staff sessions end after this long without a request (default 30 minutes)… */
  STAFF_SESSION_IDLE_MINUTES: minutes(30, 8 * 60),
  /** …and at most this long after sign-in (default 12 hours). */
  STAFF_SESSION_MAX_HOURS: hours(12),
  /** Learner exam sessions: longer idle allowance (reading a long question isn't activity). */
  LEARNER_SESSION_IDLE_MINUTES: minutes(120, 12 * 60),
  LEARNER_SESSION_MAX_HOURS: hours(12),
  /** How long after results are published an exam password still signs in, to view the result. */
  RESULTS_ACCESS_DAYS: z.coerce.number().int().min(1).max(365).default(30),

  /** Where uploaded files are kept: "local" (a folder on this machine) or "memory" (tests). */
  STORAGE_DRIVER: z.enum(["local", "memory"]).optional(),
  /** Folder for the local driver. Defaults to ~/.accredian-assessment/storage outside production. */
  STORAGE_LOCAL_DIR: z.string().min(1).optional(),
  /**
   * Email delivery. "outbox" records every email without sending it (no email service yet);
   * "test" also keeps them in memory for tests. A real provider can be added behind the same interface.
   */
  EMAIL_PROVIDER: z.enum(["outbox", "test"]).optional(),
  /** Malware scanning of uploads: "none" (files are recorded as not scanned) or "test" (tests only). */
  MALWARE_SCANNER: z.enum(["none", "test"]).optional(),
  /** Public address of the app, used for links in emails and the same-origin check. */
  APP_URL: z.url().optional(),
  /**
   * "true" only behind a reverse proxy that sets X-Forwarded-For itself: the client IP (for sign-in
   * throttling and audit) is then read from it. Otherwise the header could be forged.
   */
  TRUST_PROXY: z.enum(["true", "false"]).optional(),
});

type Raw = z.infer<typeof envSchema>;

export type Env = Omit<Raw, "STORAGE_DRIVER" | "EMAIL_PROVIDER" | "MALWARE_SCANNER" | "APP_URL" | "TRUST_PROXY"> & {
  STORAGE_DRIVER: "local" | "memory";
  EMAIL_PROVIDER: "outbox" | "test";
  MALWARE_SCANNER: "none" | "test";
  APP_URL: string;
  TRUST_PROXY: boolean;
};

const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0)$/i;

/** The database name of a postgresql:// URL ("" if it can't be parsed). */
export function databaseName(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
  } catch {
    return "";
  }
}

/** The settings production must set explicitly, with what is wrong about each (never its value). */
export function productionIssues(raw: Raw): string[] {
  const issues: string[] = [];
  if (/test/i.test(databaseName(raw.DATABASE_URL))) issues.push("DATABASE_URL points at a test database; tests wipe it.");
  if (!raw.APP_URL) issues.push("APP_URL is required in production (the public https:// address of the app).");
  else {
    const url = new URL(raw.APP_URL);
    if (url.protocol !== "https:") issues.push("APP_URL must use https:// in production.");
    if (LOCAL_HOST.test(url.hostname)) issues.push("APP_URL must not point at localhost in production.");
  }
  if (!raw.STORAGE_DRIVER) issues.push("STORAGE_DRIVER is required in production.");
  else if (raw.STORAGE_DRIVER === "memory") issues.push('STORAGE_DRIVER "memory" is for tests only; files would be lost on restart.');
  else if (!raw.STORAGE_LOCAL_DIR || !/^([a-zA-Z]:[\\/]|\/)/.test(raw.STORAGE_LOCAL_DIR)) {
    issues.push('STORAGE_LOCAL_DIR must be set to an absolute path when STORAGE_DRIVER is "local" in production.');
  }
  if (!raw.EMAIL_PROVIDER) issues.push('EMAIL_PROVIDER is required in production ("outbox" records emails without sending them).');
  else if (raw.EMAIL_PROVIDER === "test") issues.push('EMAIL_PROVIDER "test" is for tests only.');
  if (!raw.MALWARE_SCANNER) issues.push('MALWARE_SCANNER is required in production ("none" records uploads as not scanned).');
  else if (raw.MALWARE_SCANNER === "test") issues.push('MALWARE_SCANNER "test" is for tests only.');
  if (!raw.TRUST_PROXY) issues.push('TRUST_PROXY is required in production ("true" only behind a proxy that sets X-Forwarded-For).');
  return issues;
}

/**
 * Parse and validate a set of environment variables (exported for tests). The production rules
 * apply to a running server, not to `next build` (which also evaluates server modules): the build
 * machine needn't hold production settings, and the server checks them when it starts.
 */
export function parseEnv(source: Record<string, string | undefined>): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const raw = parsed.data;
  if (raw.NODE_ENV === "production" && source.NEXT_PHASE !== "phase-production-build") {
    const issues = productionIssues(raw);
    if (issues.length) throw new Error(`Invalid production configuration:\n${issues.map((i) => `  - ${i}`).join("\n")}`);
  }
  return {
    ...raw,
    STORAGE_DRIVER: raw.STORAGE_DRIVER ?? "local",
    EMAIL_PROVIDER: raw.EMAIL_PROVIDER ?? "outbox",
    MALWARE_SCANNER: raw.MALWARE_SCANNER ?? "none",
    APP_URL: raw.APP_URL ?? "http://localhost:3000",
    TRUST_PROXY: raw.TRUST_PROXY === "true",
  };
}

let cached: Env | undefined;

/** Validated server environment. Throws a readable error on misconfiguration. */
export function env(): Env {
  cached ??= parseEnv(process.env);
  return cached;
}
