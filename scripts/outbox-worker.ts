/**
 * Email outbox worker: delivers queued emails (communication_logs rows in PENDING) through the
 * configured provider, retrying failures with backoff. Safe to run in several copies at once —
 * rows are claimed atomically. Run alongside the web server in production:
 *
 *   npm run outbox:work            — keep polling (every OUTBOX_POLL_SECONDS, default 30)
 *   npm run outbox:work -- --once  — one pass, then exit (e.g. from cron)
 */
import "dotenv/config";
import { deliverPendingEmails } from "../src/server/email/outbox";
import { env } from "../src/server/env";

const once = process.argv.includes("--once");
const pollMs = Math.max(5, Number(process.env.OUTBOX_POLL_SECONDS ?? 30)) * 1000;

async function pass() {
  const run = await deliverPendingEmails();
  if (run.claimed) console.log(`[outbox] ${new Date().toISOString()} claimed ${run.claimed}: sent ${run.sent}, not delivered ${run.notDelivered}, retrying ${run.retrying}, failed ${run.failed}`);
}

async function main() {
  env(); // fail fast on a misconfigured environment
  if (once) return pass();
  console.log(`[outbox] polling every ${pollMs / 1000}s (provider: ${env().EMAIL_PROVIDER})`);
  for (;;) {
    await pass().catch((err) => console.error("[outbox] pass failed:", err));
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
