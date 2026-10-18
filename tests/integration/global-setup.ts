import { execSync } from "node:child_process";
import { getTestDatabaseUrl } from "./test-database";

/**
 * Bring the test database schema up to date once before the integration run. The Prisma CLI may
 * read DIRECT_URL (prisma.config.ts), so both variables point at the test database here — the
 * migration must never reach the development or a hosted database.
 */
export default function setup() {
  const url = getTestDatabaseUrl();
  execSync("npx prisma migrate deploy", {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url },
  });
}
