import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { calculatorReducer, evaluate, formatResult, initialCalculatorState, keyToAction, type CalculatorAction, type CalculatorState } from "@/lib/calculator/engine";

const ok = (expr: string, angle: "DEG" | "RAD" = "DEG") => {
  const r = evaluate(expr, angle);
  if (!r.ok) throw new Error(`${expr}: ${r.error}`);
  return r.value;
};
const run = (actions: CalculatorAction[], from: CalculatorState = initialCalculatorState) => actions.reduce(calculatorReducer, from);
const type = (s: string): CalculatorAction[] => [...s].map((value) => ({ type: "input", value }));

describe("basic arithmetic", () => {
  it("adds, subtracts, multiplies and divides with the usual precedence", () => {
    expect(ok("25×4")).toBe(100);
    expect(ok("2+3×4")).toBe(14);
    expect(ok("(2+3)×4")).toBe(20);
    expect(ok("10−4−3")).toBe(3);
    expect(ok("100÷8")).toBe(12.5);
    expect(ok("7÷2÷2")).toBe(1.75);
  });

  it("handles decimals without floating-point noise", () => {
    expect(ok("0.1+0.2")).toBe(0.3);
    expect(ok("1.5×1.5")).toBe(2.25);
    expect(ok(".5+.25")).toBe(0.75);
    expect(ok("10÷3")).toBe(3.33333333333);
  });

  it("percent and sign", () => {
    expect(ok("50%")).toBe(0.5);
    expect(ok("200×10%")).toBe(20);
    expect(ok("−5+2")).toBe(-3);
    expect(ok("3×−2")).toBe(-6);
  });

  it("divide by zero and invalid input are reported, never thrown", () => {
    expect(evaluate("5÷0")).toEqual({ ok: false, error: "Cannot divide by zero" });
    expect(evaluate("5÷(2−2)")).toEqual({ ok: false, error: "Cannot divide by zero" });
    for (const bad of ["", "5+", "×5", "2..3", "5++", "abc", "alert(1)", "1;2", "constructor", "2e"]) {
      expect(evaluate(bad).ok, bad).toBe(false);
    }
  });
});

describe("scientific functions", () => {
  it("roots, powers, logarithms, π and parentheses", () => {
    expect(ok("√(81)")).toBe(9);
    expect(ok("5^2")).toBe(25);
    expect(ok("2^10")).toBe(1024);
    expect(ok("2^3^2")).toBe(512); // right-associative
    expect(ok("−2^2")).toBe(-4);
    expect(ok("log(1000)")).toBe(3);
    expect(ok("ln(1)")).toBe(0);
    expect(ok("π")).toBe(3.14159265359);
    expect(ok("2π")).toBe(6.28318530718);
    expect(ok("3(4+1)")).toBe(15);
    expect(ok("(1+2")).toBe(3); // an unclosed parenthesis closes at the end
  });

  it("trigonometry in degrees and radians, exact at the standard angles", () => {
    expect(ok("sin(30)")).toBe(0.5);
    expect(ok("cos(60)")).toBe(0.5);
    expect(ok("sin(180)")).toBe(0);
    expect(ok("tan(45)")).toBe(1);
    expect(ok("sin(π÷2)", "RAD")).toBe(1);
    expect(evaluate("tan(90)")).toEqual({ ok: false, error: "Math error" });
  });

  it("out-of-domain input is a math error", () => {
    for (const bad of ["√(−4)", "log(0)", "ln(−1)", "(−8)^0.5", "10^400"]) expect(evaluate(bad), bad).toMatchObject({ ok: false });
  });

  it("formats results for the display", () => {
    expect(formatResult(100)).toBe("100");
    expect(formatResult(0.000000000012)).toBe("1.2e-11");
    expect(formatResult(1e15)).toBe("1e+15");
  });
});

describe("calculator state", () => {
  it("25 × 4 = 100, then continues from the result or starts over", () => {
    const s = run([...type("25×4"), { type: "evaluate" }]);
    expect(s).toMatchObject({ expression: "25×4", result: "100", justEvaluated: true });
    expect(run([...type("+5"), { type: "evaluate" }], s).result).toBe("105");
    expect(run(type("7"), s)).toMatchObject({ expression: "7", result: null });
  });

  it("AC clears, backspace deletes, ± toggles the current number, operators don't stack", () => {
    expect(run([...type("12+3"), { type: "clear" }])).toMatchObject({ expression: "", result: null });
    expect(run([...type("12+3"), { type: "backspace" }]).expression).toBe("12+");
    expect(run([...type("12+3"), { type: "negate" }]).expression).toBe("12+−3");
    expect(run([...type("12+3"), { type: "negate" }, { type: "negate" }]).expression).toBe("12+3");
    expect(run(type("12+×")).expression).toBe("12×");
    expect(run(type("1.2.3")).expression).toBe("1.23");
  });

  it("errors show a message and recover on the next input", () => {
    const s = run([...type("5÷0"), { type: "evaluate" }]);
    expect(s).toMatchObject({ error: true, result: "Cannot divide by zero" });
    expect(run(type("2"), s)).toMatchObject({ expression: "5÷02", error: false });
    expect(run([{ type: "clear" }, ...type("2"), { type: "evaluate" }], s).result).toBe("2");
  });

  it("memory: M+, M−, MR, MC", () => {
    let s = run([...type("10"), { type: "evaluate" }, { type: "memory", op: "M+" }]);
    s = run([...type("3"), { type: "memory", op: "M−" }, { type: "clear" }, { type: "memory", op: "MR" }], s);
    expect(s.expression).toBe("7");
    expect(run([{ type: "memory", op: "MC" }], s).memory).toBe(0);
  });

  it("keyboard input maps to the same actions", () => {
    expect(keyToAction("*", "BASIC")).toEqual({ type: "input", value: "×" });
    expect(keyToAction("Enter", "BASIC")).toEqual({ type: "evaluate" });
    expect(keyToAction("(", "BASIC")).toBeNull();
    expect(keyToAction("(", "SCIENTIFIC")).toEqual({ type: "input", value: "(" });
    expect(keyToAction("a", "SCIENTIFIC")).toBeNull();
  });
});

describe("safety", () => {
  const ROOT = path.resolve(__dirname, "../../src");
  function files(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const p = path.join(dir, name);
      if (name === "generated") return [];
      return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(name) ? [p] : [];
    });
  }

  it("no eval or Function constructor anywhere in the application source", () => {
    for (const f of files(ROOT)) {
      const src = readFileSync(f, "utf8");
      expect(/\beval\s*\(|new\s+Function\s*\(|\bFunction\s*\(\s*["'`]/.test(src), f).toBe(false);
    }
  });

  it("the calculator is browser-only: no server calls, storage or URL state", () => {
    for (const f of ["lib/calculator/engine.ts", "components/exam/calculator.tsx"]) {
      const src = readFileSync(path.join(ROOT, f), "utf8");
      expect(/@\/server|fetch\(|localStorage|sessionStorage|searchParams|useSearchParams|history\./.test(src), f).toBe(false);
    }
  });
});
