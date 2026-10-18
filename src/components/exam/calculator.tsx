"use client";

import { useReducer, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { GripHorizontal, X } from "lucide-react";
import { cn } from "cn";
import { calculatorReducer, initialCalculatorState, keyToAction, type CalculatorAction, type CalculatorKind } from "@/lib/calculator/engine";

/*
 * The learners' on-screen calculator: a floating, draggable panel over the exam. Its state lives
 * only in this component (the learner's browser) — it never talks to the server and doesn't touch
 * answers, autosave, the timer or navigation. Evaluation is the safe parser in lib/calculator.
 */

interface Key {
  label: string;
  action: CalculatorAction;
  aria?: string;
  tone?: "op" | "fn" | "eq" | "clear";
  wide?: boolean;
}

const input = (value: string, label = value, aria?: string, tone?: Key["tone"]): Key => ({ label, action: { type: "input", value }, aria, tone });

const BASIC_KEYS: Key[] = [
  { label: "AC", action: { type: "clear" }, aria: "All clear", tone: "clear" },
  { label: "±", action: { type: "negate" }, aria: "Change sign", tone: "fn" },
  input("%", "%", "Percent", "fn"),
  input("÷", "÷", "Divide", "op"),
  input("7"),
  input("8"),
  input("9"),
  input("×", "×", "Multiply", "op"),
  input("4"),
  input("5"),
  input("6"),
  input("−", "−", "Subtract", "op"),
  input("1"),
  input("2"),
  input("3"),
  input("+", "+", "Add", "op"),
  { ...input("0"), wide: true },
  input(".", ".", "Decimal point"),
  { label: "=", action: { type: "evaluate" }, aria: "Equals", tone: "eq" },
];

const SCIENTIFIC_KEYS: Key[] = [
  { label: "MC", action: { type: "memory", op: "MC" }, aria: "Memory clear", tone: "fn" },
  { label: "MR", action: { type: "memory", op: "MR" }, aria: "Memory recall", tone: "fn" },
  { label: "M+", action: { type: "memory", op: "M+" }, aria: "Memory add", tone: "fn" },
  { label: "M−", action: { type: "memory", op: "M−" }, aria: "Memory subtract", tone: "fn" },
  input("(", "(", "Open parenthesis", "fn"),
  input(")", ")", "Close parenthesis", "fn"),
  input("√(", "√", "Square root", "fn"),
  input("^2", "x²", "Square", "fn"),
  input("^", "xʸ", "Power", "fn"),
  input("π", "π", "Pi", "fn"),
  input("sin(", "sin", "Sine", "fn"),
  input("cos(", "cos", "Cosine", "fn"),
  input("tan(", "tan", "Tangent", "fn"),
  input("log(", "log", "Logarithm base 10", "fn"),
  input("ln(", "ln", "Natural logarithm", "fn"),
  { label: "⌫", action: { type: "backspace" }, aria: "Delete last", tone: "fn" },
];

const TONE: Record<NonNullable<Key["tone"]> | "num", string> = {
  num: "bg-background hover:bg-muted",
  fn: "bg-muted/70 hover:bg-muted text-foreground",
  op: "bg-primary/10 text-primary hover:bg-primary/15",
  eq: "bg-primary text-primary-foreground hover:bg-primary/90",
  clear: "bg-red-50 text-red-700 hover:bg-red-100",
};

export function Calculator({ kind, onClose }: { kind: CalculatorKind; onClose: () => void }) {
  const [state, dispatch] = useReducer(calculatorReducer, initialCalculatorState);
  const scientific = kind === "SCIENTIFIC";
  // Position as an offset from the default bottom-right corner (dragged by the title bar).
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    // Only keys pressed inside the calculator; typing in an answer box is never captured.
    if (e.key === "Escape") return onClose();
    if (e.target instanceof HTMLButtonElement && (e.key === "Enter" || e.key === " ")) return; // the focused button handles it
    const action = keyToAction(e.key, kind);
    if (action) {
      e.preventDefault();
      dispatch(action);
    }
  }
  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    drag.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y };
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function onPointerMove(e: PointerEvent<HTMLDivElement>) {
    const d = drag.current;
    if (!d) return;
    // Keep at least part of the panel on screen.
    const x = Math.min(0, Math.max(-(window.innerWidth - 120), d.ox + e.clientX - d.x));
    const y = Math.min(0, Math.max(-(window.innerHeight - 80), d.oy + e.clientY - d.y));
    setOffset({ x, y });
  }

  const display = state.justEvaluated || state.error ? state.result : null;
  const button = (k: Key) => (
    <button
      key={k.label}
      type="button"
      onClick={() => dispatch(k.action)}
      aria-label={k.aria ?? k.label}
      className={cn("h-10 rounded-md border text-sm font-medium tabular-nums transition-colors focus-visible:ring-3 focus-visible:ring-ring/40 focus-visible:outline-none", TONE[k.tone ?? "num"], k.wide && "col-span-2")}
    >
      {k.label}
    </button>
  );

  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-label={scientific ? "Scientific calculator" : "Calculator"}
      onKeyDown={onKeyDown}
      className={cn("fixed right-4 bottom-4 z-40 rounded-xl border bg-card shadow-lg", scientific ? "w-[22rem]" : "w-64")}
      style={{ transform: `translate(${offset.x}px, ${offset.y}px)` }}
    >
      <div
        className="flex cursor-move touch-none items-center justify-between gap-2 border-b px-3 py-2 select-none"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={() => (drag.current = null)}
      >
        <span className="flex items-center gap-1.5 text-sm font-semibold">
          <GripHorizontal className="size-4 text-muted-foreground" aria-hidden />
          {scientific ? "Scientific calculator" : "Calculator"}
        </span>
        <span className="flex items-center gap-1">
          {scientific ? (
            <button
              type="button"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => dispatch({ type: "angle" })}
              className="rounded px-1.5 py-0.5 text-xs font-medium text-primary hover:bg-muted"
              aria-label={`Angle unit: ${state.angle === "DEG" ? "degrees" : "radians"}. Switch`}
            >
              {state.angle}
            </button>
          ) : null}
          <button type="button" onPointerDown={(e) => e.stopPropagation()} onClick={onClose} className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="Close calculator">
            <X className="size-4" />
          </button>
        </span>
      </div>
      <div className="px-3 pt-3">
        <div className="rounded-md bg-muted/60 px-3 py-2 text-right font-mono">
          <div className="min-h-5 truncate text-xs text-muted-foreground" aria-label="Expression">
            {state.expression || "0"}
            {state.memory !== 0 ? <span className="ml-2 text-primary">M</span> : null}
          </div>
          <div className={cn("min-h-7 truncate text-xl font-semibold tabular-nums", state.error && "text-base text-destructive")} role="status" aria-live="polite" aria-label="Result">
            {display ?? ""}
          </div>
        </div>
      </div>
      <div className={cn("grid gap-3 p-3", scientific && "grid-cols-[1fr_1fr]")}>
        {scientific ? <div className="grid grid-cols-2 content-start gap-1.5">{SCIENTIFIC_KEYS.map(button)}</div> : null}
        <div className="grid grid-cols-4 gap-1.5">{BASIC_KEYS.map(button)}</div>
      </div>
    </div>
  );
}
