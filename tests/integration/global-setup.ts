import { execSync } from "node:child_process";
import { getTestDatabaseUrl } from "./test-database";

/** Bring the test database schema up to date once before the integration run. */
export default function setup() {
  const url = getTestDatabaseUrl();
  execSync("npx prisma migrate deploy", {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: url },
  });
}
