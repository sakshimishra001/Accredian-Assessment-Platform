/**
 * Runs once when a server instance starts, before it handles requests. On the Node.js runtime it
 * validates the environment (see instrumentation-node.ts), so a misconfigured production server
 * stops at startup with a clear message instead of failing on the first request.
 */
export async function register() {
  // `next build` is not a server start: the runtime environment is checked when the server starts.
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.NEXT_PHASE !== "phase-production-build") {
    await import("./instrumentation-node");
  }
}
