/*
 * The learners' on-screen calculator: a small, safe expression evaluator and the calculator's state
 * machine. Everything here is plain TypeScript — no eval, no Function constructor, no dynamic code:
 * input is tokenised against a fixed set of symbols and evaluated by a recursive-descent parser.
 * Nothing is sent to the server; the state lives only in the learner's browser.
 *
 * Grammar (highest precedence last):
 *   expr    := term (('+' | '−') term)*
 *   term    := unary (('×' | '÷') unary | <implicit ×> power)*
 *   unary   := ('−' | '+') unary | power
 *   power   := postfix ('^' unary)?            right-associative; −2^2 = −4
 *   postfix := primary '%'*                    50% = 0.5
 *   primary := number | 'π' | func '(' expr ')' | '(' expr ')'     unclosed '(' close at the end
 */

export type CalculatorKind = "BASIC" | "SCIENTIFIC";
export type AngleMode = "DEG" | "RAD";

export const FUNCTIONS = ["sin", "cos", "tan", "log", "ln", "√"] as const;
type Fn = (typeof FUNCTIONS)[number];

type Token = { t: "num"; v: number } | { t: "op"; v: "+" | "−" | "×" | "÷" | "^" | "%" } | { t: "lp" } | { t: "rp" } | { t: "pi" } | { t: "fn"; v: Fn };

export type Evaluation = { ok: true; value: number } | { ok: false; error: string };

class CalcError extends Error {}

const NUMBER = /^(\d+\.?\d*|\.\d+)(e[+−-]?\d+)?/i;

function tokenize(input: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const rest = input.slice(i);
    const c = input[i];
    if (c === " ") {
      i++;
      continue;
    }
    const num = NUMBER.exec(rest);
    if (num) {
      // Two numbers back to back ("2..3", "1.5.2") are a typing error, not an implicit product.
      if (out.at(-1)?.t === "num") throw new CalcError("Invalid expression");
      out.push({ t: "num", v: Number(num[0].replace("−", "-")) });
      i += num[0].length;
      continue;
    }
    const fn = FUNCTIONS.find((f) => rest.startsWith(f));
    if (fn) {
      out.push({ t: "fn", v: fn });
      i += fn.length;
      continue;
    }
    if (c === "π") out.push({ t: "pi" });
    else if (c === "(") out.push({ t: "lp" });
    else if (c === ")") out.push({ t: "rp" });
    else if (c === "+" || c === "−" || c === "×" || c === "÷" || c === "^" || c === "%") out.push({ t: "op", v: c });
    else if (c === "-") out.push({ t: "op", v: "−" });
    else if (c === "*") out.push({ t: "op", v: "×" });
    else if (c === "/") out.push({ t: "op", v: "÷" });
    else throw new CalcError("Invalid expression");
    i++;
  }
  return out;
}

const DEG = Math.PI / 180;

function applyFn(fn: Fn, x: number, angle: AngleMode): number {
  const a = angle === "DEG" ? x * DEG : x;
  switch (fn) {
    case "sin":
      return angle === "DEG" && Number.isInteger(x) && x % 180 === 0 ? 0 : Math.sin(a);
    case "cos":
      return angle === "DEG" && Number.isInteger(x) && (x - 90) % 180 === 0 ? 0 : Math.cos(a);
    case "tan":
      if (angle === "DEG" && Number.isInteger(x) && (x - 90) % 180 === 0) throw new CalcError("Math error");
      return angle === "DEG" && Number.isInteger(x) && x % 180 === 0 ? 0 : Math.tan(a);
    case "log":
      if (x <= 0) throw new CalcError("Math error");
      return Math.log10(x);
    case "ln":
      if (x <= 0) throw new CalcError("Math error");
      return Math.log(x);
    case "√":
      if (x < 0) throw new CalcError("Math error");
      return Math.sqrt(x);
  }
}

/** Evaluate an expression safely. Errors are returned, never thrown. */
export function evaluate(input: string, angle: AngleMode = "DEG"): Evaluation {
  let tokens: Token[];
  try {
    tokens = tokenize(input);
  } catch {
    return { ok: false, error: "Invalid expression" };
  }
  if (tokens.length === 0) return { ok: false, error: "Invalid expression" };
  let pos = 0;
  const peek = () => tokens[pos];
  const isOp = (v: string) => peek()?.t === "op" && (peek() as { v: string }).v === v;
  const startsOperand = () => {
    const p = peek();
    return !!p && (p.t === "num" || p.t === "pi" || p.t === "fn" || p.t === "lp");
  };

  function primary(): number {
    const tok = tokens[pos++];
    if (!tok) throw new CalcError("Invalid expression");
    if (tok.t === "num") return tok.v;
    if (tok.t === "pi") return Math.PI;
    if (tok.t === "fn") {
      if (peek()?.t !== "lp") throw new CalcError("Invalid expression");
      pos++;
      const v = expr();
      if (peek()?.t === "rp") pos++;
      else if (pos < tokens.length) throw new CalcError("Invalid expression");
      return applyFn(tok.v, v, angle);
    }
    if (tok.t === "lp") {
      const v = expr();
      if (peek()?.t === "rp") pos++;
      else if (pos < tokens.length) throw new CalcError("Invalid expression");
      return v;
    }
    throw new CalcError("Invalid expression");
  }
  function postfix(): number {
    let v = primary();
    while (isOp("%")) {
      pos++;
      v /= 100;
    }
    return v;
  }
  function power(): number {
    const base = postfix();
    if (isOp("^")) {
      pos++;
      const exp = unary();
      const v = Math.pow(base, exp);
      if (Number.isNaN(v)) throw new CalcError("Math error");
      return v;
    }
    return base;
  }
  function unary(): number {
    if (isOp("−")) {
      pos++;
      return -unary();
    }
    if (isOp("+")) {
      pos++;
      return unary();
    }
    return power();
  }
  function term(): number {
    let v = unary();
    for (;;) {
      if (isOp("×")) {
        pos++;
        v *= unary();
      } else if (isOp("÷")) {
        pos++;
        const d = unary();
        if (d === 0) throw new CalcError("Cannot divide by zero");
        v /= d;
      } else if (startsOperand()) {
        v *= power(); // implicit multiplication: 2π, 3(4), 2√(9)
      } else return v;
    }
  }
  function expr(): number {
    let v = term();
    for (;;) {
      if (isOp("+")) {
        pos++;
        v += term();
      } else if (isOp("−")) {
        pos++;
        v -= term();
      } else return v;
    }
  }

  try {
    const value = expr();
    if (pos !== tokens.length) return { ok: false, error: "Invalid expression" };
    if (!Number.isFinite(value)) return { ok: false, error: "Math error" };
    return { ok: true, value: tidy(value) };
  } catch (err) {
    return { ok: false, error: err instanceof CalcError ? err.message : "Invalid expression" };
  }
}

/** Round away floating-point noise (0.1 + 0.2 → 0.3, sin 180° → 0). */
function tidy(n: number): number {
  const v = Number.parseFloat(n.toPrecision(12));
  return Object.is(v, -0) ? 0 : v;
}

/** Display form of a number: up to 12 significant digits, exponent form for very large/small values. */
export function formatResult(n: number): string {
  if (n === 0) return "0";
  const abs = Math.abs(n);
  if (abs >= 1e12 || abs < 1e-9) return n.toExponential(6).replace(/\.?0+e/, "e");
  return String(tidy(n));
}

// ---------------------------------------------------------------------------
// State machine (what the buttons and keys do)
// ---------------------------------------------------------------------------

export interface CalculatorState {
  /** The expression being typed, e.g. "25×4". */
  expression: string;
  /** The last result, or an error message, shown under the expression. */
  result: string | null;
  error: boolean;
  /** After "=", typing a digit starts a new expression; an operator continues from the result. */
  justEvaluated: boolean;
  memory: number;
  angle: AngleMode;
}

export const initialCalculatorState: CalculatorState = { expression: "", result: null, error: false, justEvaluated: false, memory: 0, angle: "DEG" };

export type CalculatorAction =
  | { type: "input"; value: string }
  | { type: "clear" }
  | { type: "backspace" }
  | { type: "negate" }
  | { type: "evaluate" }
  | { type: "memory"; op: "MC" | "MR" | "M+" | "M−" }
  | { type: "angle" };

const BINARY = ["+", "−", "×", "÷", "^"];
const MAX_EXPRESSION = 120;

/** The number at the end of the expression, with where it starts. */
function lastNumber(expr: string) {
  const m = /(\d+\.?\d*|\.\d+)(e[+−-]?\d+)?$/i.exec(expr);
  return m ? { start: m.index, text: m[0] } : null;
}

export function calculatorReducer(state: CalculatorState, action: CalculatorAction): CalculatorState {
  switch (action.type) {
    case "clear":
      return { ...state, expression: "", result: null, error: false, justEvaluated: false };
    case "angle":
      return { ...state, angle: state.angle === "DEG" ? "RAD" : "DEG" };
    case "backspace": {
      if (state.justEvaluated) return { ...state, justEvaluated: false, result: null, error: false };
      const fn = FUNCTIONS.find((f) => state.expression.endsWith(`${f}(`));
      const cut = fn ? fn.length + 1 : 1;
      return { ...state, expression: state.expression.slice(0, -cut), error: false };
    }
    case "negate": {
      const base = state.justEvaluated && state.result && !state.error ? state.result : state.expression;
      const n = lastNumber(base);
      if (!n) return state;
      const before = base.slice(0, n.start);
      // Toggle a unary minus directly in front of the number (but not a subtraction).
      const unaryMinus = before.endsWith("−") && (before.length === 1 || /[(+−×÷^]$/.test(before.slice(0, -1)));
      const expression = unaryMinus ? before.slice(0, -1) + n.text : `${before}−${n.text}`;
      return { ...state, expression, justEvaluated: false, error: false };
    }
    case "evaluate": {
      if (!state.expression) return state;
      const r = evaluate(state.expression, state.angle);
      return r.ok ? { ...state, result: formatResult(r.value), error: false, justEvaluated: true } : { ...state, result: r.error, error: true, justEvaluated: false };
    }
    case "memory": {
      const current = state.justEvaluated && !state.error && state.result ? Number(state.result) : (() => {
        const r = evaluate(state.expression || "0", state.angle);
        return r.ok ? r.value : null;
      })();
      if (action.op === "MC") return { ...state, memory: 0 };
      if (action.op === "MR") return calculatorReducer(state, { type: "input", value: formatResult(state.memory) });
      if (current === null || !Number.isFinite(current)) return state;
      return { ...state, memory: tidy(state.memory + (action.op === "M+" ? current : -current)) };
    }
    case "input": {
      let { expression } = state;
      const v = action.value;
      const startsValue = /^[\d.π(]/.test(v) || FUNCTIONS.some((f) => v.startsWith(f));
      if (state.justEvaluated) {
        // A new number starts over; an operator (or %) continues from the result.
        expression = startsValue || state.error || !state.result ? "" : state.result;
      }
      if (BINARY.includes(v) || v === "%") {
        if (expression === "" && v !== "−") return state;
        // Replace a trailing operator instead of stacking two.
        if (BINARY.includes(expression.slice(-1)) && v !== "−") expression = expression.slice(0, -1);
      }
      if (v === "." ) {
        const n = lastNumber(expression);
        if (n?.text.includes(".")) return state;
        if (!n) expression += "0";
      }
      if ((expression + v).length > MAX_EXPRESSION) return state;
      return { ...state, expression: expression + v, justEvaluated: false, error: false, result: state.justEvaluated ? null : state.result };
    }
  }
}

/** Keyboard → calculator action (null for keys the calculator doesn't use). */
export function keyToAction(key: string, kind: CalculatorKind): CalculatorAction | null {
  if (/^[0-9]$/.test(key) || key === ".") return { type: "input", value: key };
  if (key === "+") return { type: "input", value: "+" };
  if (key === "-") return { type: "input", value: "−" };
  if (key === "*" || key.toLowerCase() === "x") return { type: "input", value: "×" };
  if (key === "/") return { type: "input", value: "÷" };
  if (key === "%") return { type: "input", value: "%" };
  if (key === "Enter" || key === "=") return { type: "evaluate" };
  if (key === "Backspace") return { type: "backspace" };
  if (key === "Delete") return { type: "clear" };
  if (kind === "SCIENTIFIC") {
    if (key === "(" || key === ")") return { type: "input", value: key };
    if (key === "^") return { type: "input", value: "^" };
  }
  return null;
}
