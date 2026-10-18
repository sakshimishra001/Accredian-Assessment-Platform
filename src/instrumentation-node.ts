import { env } from "./server/env";

// Node.js server start only (imported from instrumentation.ts): refuse to run with a bad environment.
try {
  env();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  console.error("The server will not start until this is fixed.");
  process.exit(1);
}
