import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { affectsView, MONITORING_EVENT_TYPES, pollIntervalMs, type MonitoringEvent } from "@/lib/proctoring/monitoring-events";
import { createMonitoringBus, SubscriberLimitError } from "@/server/realtime/bus";
import { createMonitoringStream } from "@/server/realtime/sse";

/*
 * Proctor dashboard, phase 5: the in-process monitoring event bus, publishing only after a commit,
 * the SSE stream, and the dashboard client's rules. No database or browser is needed.
 */

vi.mock("@/server/db", () => ({ db: { $transaction: async <T,>(fn: (tx: unknown) => Promise<T>) => fn({}) } }));
vi.stubEnv("DATABASE_URL", "postgresql://unit:unit@localhost:5432/unit_test");

const ev = (type: MonitoringEvent["type"], assessmentId = "exam-A", attemptId: string | null = "att-1"): MonitoringEvent => ({ type, assessmentId, attemptId, at: "2026-10-22T10:00:00.000Z" });

describe("event bus", () => {
  it("delivers an assessment's events to its subscribers only; unsubscribe stops delivery and leaves nothing behind", () => {
    const bus = createMonitoringBus();
    const a1: MonitoringEvent[] = [];
    const a2: MonitoringEvent[] = [];
    const b: MonitoringEvent[] = [];
    const offA1 = bus.subscribe("exam-A", (e) => a1.push(e));
    const offA2 = bus.subscribe("exam-A", (e) => a2.push(e));
    const offB = bus.subscribe("exam-B", (e) => b.push(e));
    bus.publish(ev("ATTEMPT_STARTED"));
    bus.publish(ev("ATTEMPT_LOCKED", "exam-B", "att-9"));
    expect(a1.map((e) => e.type)).toEqual(["ATTEMPT_STARTED"]);
    expect(a2.map((e) => e.type)).toEqual(["ATTEMPT_STARTED"]);
    expect(b.map((e) => e.type)).toEqual(["ATTEMPT_LOCKED"]); // assessment isolation
    offA1();
    offA1(); // idempotent
    bus.publish(ev("ATTEMPT_SUBMITTED"));
    expect(a1).toHaveLength(1);
    expect(a2).toHaveLength(2);
    offA2();
    offB();
    expect(bus.subscriberCount()).toBe(0);
    expect(bus.topicCount()).toBe(0); // no empty topics retained
  });

  it("a failing subscriber affects neither the others nor the publisher", () => {
    const bus = createMonitoringBus();
    const got: string[] = [];
    bus.subscribe("exam-A", () => {
      throw new Error("broken connection");
    });
    bus.subscribe("exam-A", (e) => got.push(e.type));
    expect(() => bus.publish(ev("PROCTORING_VIOLATION"))).not.toThrow();
    expect(got).toEqual(["PROCTORING_VIOLATION"]);
  });

  it("listener growth is bounded per assessment", () => {
    const bus = createMonitoringBus({ maxPerAssessment: 2 });
    bus.subscribe("exam-A", () => {});
    bus.subscribe("exam-A", () => {});
    expect(() => bus.subscribe("exam-A", () => {})).toThrow(SubscriberLimitError);
    expect(() => bus.subscribe("exam-B", () => {})).not.toThrow();
  });

  it("the event types and payload carry identifiers only — no learner data", () => {
    expect([...MONITORING_EVENT_TYPES]).toEqual(
      expect.arrayContaining(["ATTEMPT_STARTED", "ATTEMPT_SUBMITTED", "ATTEMPT_AUTO_SUBMITTED", "PROCTORING_VIOLATION", "ATTEMPT_LOCKED", "ATTEMPT_TERMINATED", "ATTEMPT_PAUSED", "ATTEMPT_RESUMED", "ATTEMPT_TIME_EXTENDED"]),
    );
    expect(Object.keys(ev("ATTEMPT_STARTED")).sort()).toEqual(["assessmentId", "at", "attemptId", "type"]);
  });
});

describe("publishing only after the transaction commits", () => {
  let publish: typeof import("@/server/realtime/publish");
  let bus: typeof import("@/server/realtime/bus");
  beforeEach(async () => {
    publish = await import("@/server/realtime/publish");
    bus = await import("@/server/realtime/bus");
  });

  it("events emitted inside are published once it succeeds — de-duplicated per (type, attempt)", async () => {
    const got: MonitoringEvent[] = [];
    const off = bus.monitoringBus.subscribe("exam-A", (e) => got.push(e));
    const result = await publish.transaction(async () => {
      publish.emitMonitoringEvent("ATTEMPT_LOCKED", "exam-A", "att-1");
      publish.emitMonitoringEvent("ATTEMPT_LOCKED", "exam-A", "att-1");
      expect(got).toEqual([]); // not before the commit
      return 42;
    });
    expect(result).toBe(42);
    expect(got.map((e) => [e.type, e.attemptId])).toEqual([["ATTEMPT_LOCKED", "att-1"]]);
    off();
  });

  it("a transaction that throws (rolls back) publishes nothing", async () => {
    const got: MonitoringEvent[] = [];
    const off = bus.monitoringBus.subscribe("exam-A", (e) => got.push(e));
    await expect(
      publish.transaction(async () => {
        publish.emitMonitoringEvent("ATTEMPT_TERMINATED", "exam-A", "att-1");
        throw new Error("conflict");
      }),
    ).rejects.toThrow("conflict");
    expect(got).toEqual([]);
    off();
  });
});

describe("SSE stream", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  async function readAll(stream: ReadableStream<Uint8Array>) {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let text = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return text;
      text += decoder.decode(value);
    }
  }
  /** Collect what has been written so far without waiting for the end. */
  function collector(stream: ReadableStream<Uint8Array>) {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let text = "";
    let done = false;
    (async () => {
      for (;;) {
        const r = await reader.read();
        if (r.done) {
          done = true;
          return;
        }
        text += decoder.decode(r.value);
      }
    })();
    return { text: () => text, done: () => done };
  }

  it("opens with retry + SNAPSHOT, forwards only its assessment's events, sends heartbeats", async () => {
    const bus = createMonitoringBus();
    const stream = createMonitoringStream({ assessmentId: "exam-A", bus, recheck: async () => true, heartbeatMs: 1000, recheckMs: 60_000, maxLifetimeMs: 600_000, now: () => new Date("2026-10-22T10:00:00Z") });
    const c = collector(stream);
    await vi.advanceTimersByTimeAsync(0);
    expect(c.text()).toMatch(/^retry: 5000\n\nevent: SNAPSHOT\ndata: \{"assessmentId":"exam-A","at":"2026-10-22T10:00:00.000Z"\}\n\n/);
    bus.publish(ev("PROCTORING_VIOLATION"));
    bus.publish(ev("ATTEMPT_STARTED", "exam-B"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(c.text()).toContain("event: PROCTORING_VIOLATION\ndata: ");
    expect(c.text()).not.toContain("exam-B");
    expect(c.text()).toContain(": ping\n\n");
    expect(bus.subscriberCount("exam-A")).toBe(1);
  });

  it("the client disconnecting releases the subscription and timers", async () => {
    const bus = createMonitoringBus();
    const abort = new AbortController();
    const stream = createMonitoringStream({ assessmentId: "exam-A", bus, signal: abort.signal, recheck: async () => true });
    const c = collector(stream);
    await vi.advanceTimersByTimeAsync(0);
    expect(bus.subscriberCount("exam-A")).toBe(1);
    abort.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(bus.subscriberCount("exam-A")).toBe(0);
    expect(c.done()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("lost access (unassigned, signed out, disabled) sends REVOKED and ends the stream", async () => {
    const bus = createMonitoringBus();
    let allowed = true;
    const stream = createMonitoringStream({ assessmentId: "exam-A", bus, recheck: async () => allowed, recheckMs: 1000 });
    const out = readAll(stream);
    await vi.advanceTimersByTimeAsync(1000);
    expect(bus.subscriberCount("exam-A")).toBe(1);
    allowed = false;
    await vi.advanceTimersByTimeAsync(1000);
    expect(await out).toContain("event: REVOKED");
    expect(bus.subscriberCount("exam-A")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ends itself after its maximum lifetime (the browser reconnects and is authorized afresh)", async () => {
    const bus = createMonitoringBus();
    const stream = createMonitoringStream({ assessmentId: "exam-A", bus, recheck: async () => true, maxLifetimeMs: 5000 });
    const out = readAll(stream);
    await vi.advanceTimersByTimeAsync(5000);
    await out;
    expect(bus.subscriberCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("refused subscription (too many connections) ends the stream at once", async () => {
    const bus = createMonitoringBus({ maxPerAssessment: 0 });
    const text = await readAll(createMonitoringStream({ assessmentId: "exam-A", bus, recheck: async () => true }));
    expect(text).not.toContain("SNAPSHOT");
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("dashboard client rules", () => {
  it("an assessment page reacts to all its events; an attempt page to its attempt's and assessment-wide ones", () => {
    expect(affectsView({ attemptId: "att-1" })).toBe(true);
    expect(affectsView({ attemptId: "att-1" }, "att-1")).toBe(true);
    expect(affectsView({ attemptId: "att-2" }, "att-1")).toBe(false);
    expect(affectsView({ attemptId: null }, "att-1")).toBe(true); // pause / resume
  });

  it("polls every 20 s without the stream, every minute as a safety net with it", () => {
    expect(pollIntervalMs("polling")).toBe(20_000);
    expect(pollIntervalMs("connecting")).toBe(20_000);
    expect(pollIntervalMs("live")).toBe(60_000);
  });
});
