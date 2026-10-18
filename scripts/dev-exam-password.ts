/**
 * DEVELOPMENT / QA ONLY — set a fresh learner password for one existing learner, so a tester can
 * sign in as that learner at /learner/login (the database only keeps bcrypt hashes, never the
 * plain password).
 *
 *   npm run dev:learner-password -- --learner <email or user id> [--admin <admin email>]
 *   (npm run dev:exam-password … is the same command, kept under its old name)
 *
 * It reuses the application's own service (resetLearnerPassword), exactly like an admin's "Reset
 * password": the learner's one password — used for all their assigned assessments — is replaced,
 * their sessions end, and it is audited as issued by the admin (default: the oldest active admin).
 * The plain password is printed once to this terminal and stored nowhere. Assignments are not
 * changed: the learner can open the assessments they are assigned to, nothing else.
 *
 * Refuses to run with NODE_ENV=production, and (like db:reset / the seed) against a database whose
 * name doesn't look like a development one unless ALLOW_DEV_DB_COMMAND=<database name> is set.
 */
import "dotenv/config";
import { fileURLToPath } from "node:url";
import type { SessionUser } from "../src/server/auth/session";
import { devDatabaseProblem } from "./db-guard";

/** The app's database client and service, loaded only after the guard has passed. */
async function app() {
  const [{ db }, { resetLearnerPassword }, { AssessmentStatus, Role, UserStatus }] = await Promise.all([
    import("../src/server/db"),
    import("../src/server/services/learner-passwords"),
    import("../src/generated/prisma/enums"),
  ]);
  return { db, resetLearnerPassword, AssessmentStatus, Role, UserStatus };
}

export interface DevLearnerPasswordOptions {
  /** The learner's email or user id. */
  learner: string;
  /** Email of the active administrator recorded as issuer; default: the oldest active admin. */
  adminEmail?: string;
}

/** Why this utility must not run here, or null. Production is always refused. */
export function devExamPasswordProblem(env: Record<string, string | undefined> = process.env): string | null {
  if (env.NODE_ENV === "production") return "Refusing to set a development learner password: NODE_ENV is \"production\".";
  return devDatabaseProblem("set a development learner password", env);
}

/** Set a new password for one learner. Returns the plain password (to show once) and their assessments. */
export async function resetDevLearnerPassword(options: DevLearnerPasswordOptions) {
  const problem = devExamPasswordProblem();
  if (problem) throw new Error(problem);
  const { db, resetLearnerPassword, AssessmentStatus, Role, UserStatus } = await app();

  const key = options.learner.trim();
  const learner = await db.user.findFirst({ where: key.includes("@") ? { email: key.toLowerCase() } : { id: key }, select: { id: true, email: true, name: true, role: true } });
  if (!learner) throw new Error(`Learner ${key} not found.`);
  if (learner.role !== Role.LEARNER) throw new Error("That user isn't a learner.");

  const admin = await db.user.findFirst({
    where: options.adminEmail ? { email: options.adminEmail.trim().toLowerCase() } : { role: Role.ADMIN, status: UserStatus.ACTIVE },
    orderBy: { createdAt: "asc" },
    select: { id: true, email: true, name: true, role: true, status: true },
  });
  if (!admin || admin.role !== Role.ADMIN || admin.status !== UserStatus.ACTIVE) throw new Error("No active administrator to issue the password as.");
  const actor: SessionUser = { id: admin.id, email: admin.email, name: admin.name, role: admin.role };

  const issued = await resetLearnerPassword(actor, learner.id);
  const assessments = await db.assessmentCandidate.findMany({
    where: { learnerId: learner.id, assessment: { status: { not: AssessmentStatus.DRAFT } } },
    select: { assessment: { select: { id: true, name: true, status: true, startAt: true, endAt: true } } },
  });
  return { password: issued.password, learnerEmail: learner.email, learnerName: learner.name, assessments: assessments.map((a) => a.assessment), issuedBy: admin.email };
}

function arg(name: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const problem = devExamPasswordProblem();
  if (problem) {
    console.error(problem);
    process.exitCode = 1;
    return;
  }
  const learner = arg("learner");
  if (!learner) {
    console.error("Usage: npm run dev:learner-password -- --learner <email or id> [--admin <email>]");
    process.exitCode = 1;
    return;
  }
  const r = await resetDevLearnerPassword({ learner, adminEmail: arg("admin") });
  console.log("\nDevelopment learner password set (shown once; not stored anywhere):\n");
  console.log(`  Learner:    ${r.learnerName} <${r.learnerEmail}>`);
  console.log(`  Password:   ${r.password}`);
  console.log(`  Sign in at: /learner/login`);
  console.log(`  Assigned:   ${r.assessments.map((a) => `${a.name} (${a.status})`).join("; ") || "no assessments"}`);
  console.log(`\n  Issued as ${r.issuedBy}; the learner's previous password no longer works.\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main()
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 1;
    })
    .finally(async () => {
      if (!devExamPasswordProblem()) await (await app()).db.$disconnect();
    });
}
