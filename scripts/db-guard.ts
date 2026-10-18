/**
 * Guard for destructive or development-only database commands (reset, dev migrations, seed).
 *
 * They refuse to run when NODE_ENV is "production", or when DATABASE_URL names a database that
 * doesn't look like a development or test database (its name must contain "dev", "local" or
 * "test"). A deliberately named other database can be allowed for one run with
 * ALLOW_DEV_DB_COMMAND=<exact database name>. Never prints the connection string.
 *
 *   tsx scripts/db-guard.ts <action>   — exits 1 (with the reason) if <action> must not run.
 */
import "dotenv/config";
import { fileURLToPath } from "node:url";

export function devDatabaseProblem(action: string, env: Record<string, string | undefined> = process.env): string | null {
  if (env.NODE_ENV === "production") return `Refusing to ${action}: NODE_ENV is "production".`;
  const url = env.DATABASE_URL;
  if (!url) return `Refusing to ${action}: DATABASE_URL is not set.`;
  let name: string;
  try {
    name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
  } catch {
    return `Refusing to ${action}: DATABASE_URL is not a valid connection string.`;
  }
  if (/dev|local|test/i.test(name) || env.ALLOW_DEV_DB_COMMAND === name) return null;
  return `Refusing to ${action}: database "${name}" doesn't look like a development database. If it really is one, run again with ALLOW_DEV_DB_COMMAND=${name}.`;
}

export function assertDevDatabase(action: string) {
  const problem = devDatabaseProblem(action);
  if (problem) {
    console.error(problem);
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  assertDevDatabase(process.argv[2] ?? "run this command");
}
