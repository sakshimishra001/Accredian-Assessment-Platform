/**
 * Bootstrap the first administrator of a new deployment (the seed is development-only).
 *
 *   npm run staff:create-admin -- --email ops@example.org --name "Asha Admin"
 *
 * Creates an ADMIN account with no password and prints a one-time link (valid 72 hours) with which
 * that person sets their own password. Nothing secret is stored: only the link's SHA-256 hash.
 * Further staff accounts are created by an administrator in Users & Roles.
 */
import "dotenv/config";
import { createInterface } from "node:readline/promises";
import { createAccountWithInvite } from "../src/server/services/staff";
import { env } from "../src/server/env";
import { db } from "../src/server/db";

function arg(name: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  env();
  let email = arg("email");
  let name = arg("name");
  if (!email || !name) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    email ??= await rl.question("Administrator email: ");
    name ??= await rl.question("Full name: ");
    rl.close();
  }
  const { user, link } = await createAccountWithInvite({ name, email, role: "ADMIN" }, null);
  console.log(`\nCreated administrator ${user.email}.`);
  console.log(`Send them this one-time link (valid until ${link.expiresAt.toISOString()}); it is not shown again:\n\n  ${link.url}\n`);
}

main()
  .catch((err) => {
    const fields = (err as { fieldErrors?: Record<string, string[]> }).fieldErrors;
    console.error(err instanceof Error ? err.message : err, fields ? JSON.stringify(fields) : "");
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
