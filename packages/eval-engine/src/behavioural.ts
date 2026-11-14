import { Worker } from "node:worker_threads";
import type { EvalResult, EvaluationReport, SmokeEval } from "@dynamic-skills/core";

/**
 * Longest agent output, in characters, that regex assertions are evaluated against. The output is
 * untrusted; longer output fails every regex assertion, while `contains` / `not-contains` still
 * scan all of it (PRD §9.2).
 */
export const MAX_BEHAVIOURAL_OUTPUT_CHARS = 100_000;

/** Longest assertion regular expression accepted; longer patterns are rejected as unsafe. */
export const MAX_ASSERTION_REGEX_CHARS = 200;

/** Total wall-clock budget, in milliseconds, for evaluating every regex assertion of one call. */
export const ASSERTION_REGEX_BUDGET_MS = 1_000;

/** Longest text kept from an untrusted value (crash message, assertion value, note) in a message. */
const MAX_MESSAGE_VALUE_CHARS = 200;

/** Most `revisionHints` / `limitations` entries a report may carry (also used by the runner). */
export const MAX_REPORT_ENTRIES = 50;

/**
 * Makes an untrusted string safe to embed in a message shown to the agent: whitespace runs
 * (including newlines) collapse to one space and the result is cut to 200 characters with `…`.
 * @param value - Untrusted text.
 * @returns The sanitised text.
 */
export function sanitiseForMessage(value: string): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > MAX_MESSAGE_VALUE_CHARS
    ? `${flat.slice(0, MAX_MESSAGE_VALUE_CHARS)}…`
    : flat;
}

/**
 * Cheap pre-check for agent-written patterns, kept as a UX layer only: the safety mechanism is the
 * worker budget in {@link evaluateRegexes}. Returns a reason when the pattern is over
 * {@link MAX_ASSERTION_REGEX_CHARS}, contains a quantified group that itself contains a quantifier
 * (`?` counts), or a quantified group containing alternation, such as `(a+)+` or `(a|a)*`.
 * Escapes and character classes are skipped.
 * @param pattern - The regular-expression source from `smoke.json`.
 * @returns A human-readable reason, or null when the pattern passes the pre-check.
 */
function unsafeReason(pattern: string): string | null {
  if (pattern.length > MAX_ASSERTION_REGEX_CHARS) {
    return `longer than ${MAX_ASSERTION_REGEX_CHARS} characters`;
  }
  // One entry per open group: does it contain a quantifier / an alternation?
  const stack: { quant: boolean; alt: boolean }[] = [];
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i] as string;
    if (c === "\\") {
      i++;
    } else if (inClass) {
      if (c === "]") inClass = false;
    } else if (c === "[") {
      inClass = true;
    } else if (c === "(") {
      stack.push({ quant: false, alt: false });
      if (pattern[i + 1] === "?") i++; // group syntax such as (?: or (?=, not a quantifier
    } else if (c === "|") {
      const top = stack[stack.length - 1];
      if (top) top.alt = true;
    } else if (c === "+" || c === "*" || c === "{" || c === "?") {
      const top = stack[stack.length - 1];
      if (top) top.quant = true;
    } else if (c === ")") {
      const group = stack.pop();
      const next = pattern[i + 1];
      const quantified = next === "+" || next === "*" || next === "{" || next === "?";
      if (group && quantified && group.quant) return "nested quantifiers";
      if (group && quantified && group.alt) return "quantified alternation";
      if (group?.quant) {
        const parent = stack[stack.length - 1];
        if (parent) parent.quant = true;
      }
    }
  }
  return null;
}

/**
 * Inline worker source: tests each pattern against the text and posts one message per pattern as
 * soon as it is done, so a later hang still leaves the earlier results. Inline (`eval: true`) so it
 * works under tsx, vitest and inside a bundle without a separate file.
 */
const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
for (const { index, pattern } of workerData.patterns) {
  try {
    parentPort.postMessage({ index, matched: new RegExp(pattern).test(workerData.text) });
  } catch (err) {
    parentPort.postMessage({ index, error: String(err && err.message) });
  }
}
`;

/** Per-pattern outcome from {@link evaluateRegexes}. */
type RegexOutcome = { matched: boolean } | { error: string };

/**
 * Evaluates regular expressions against `text` inside one worker thread under a single total
 * budget. A catastrophic pattern cannot hang the caller: when the budget elapses the worker is
 * terminated and every pattern without a result gets a timeout error. No worker starts for an
 * empty list.
 * @param patterns - Pattern sources, evaluated in order.
 * @param text - The text to test (already length-checked by the caller).
 * @returns One outcome per pattern, in input order.
 */
async function evaluateRegexes(patterns: string[], text: string): Promise<RegexOutcome[]> {
  const outcomes: (RegexOutcome | undefined)[] = patterns.map(() => undefined);
  if (patterns.length === 0) return [];
  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: { text, patterns: patterns.map((pattern, index) => ({ index, pattern })) },
  });
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ASSERTION_REGEX_BUDGET_MS);
    const finish = (): void => {
      clearTimeout(timer);
      resolve();
    };
    worker.on("message", (m: { index: number; matched?: boolean; error?: string }) => {
      outcomes[m.index] =
        m.error === undefined ? { matched: m.matched === true } : { error: m.error };
      if (outcomes.every((o) => o !== undefined)) finish();
    });
    worker.on("error", finish);
    worker.on("exit", finish);
  });
  await worker.terminate();
  return outcomes.map((o) => o ?? { error: "regex evaluation timed out" });
}

/**
 * Records the behavioural smoke result (PRD §9.2, §9.4). The agent ran the scenario and supplies
 * its `output` and its own rubric `verdict`; this function adds the deterministic assertions from
 * `smoke.json`. Both inputs are untrusted. `contains` / `not-contains` scan the FULL output with a
 * linear `includes` (so a prohibited string past any cap is still found). Regex assertions run in
 * one worker thread under {@link ASSERTION_REGEX_BUDGET_MS}; they fail when the output exceeds
 * {@link MAX_BEHAVIOURAL_OUTPUT_CHARS}, when the pattern is invalid or rejected by the pre-check,
 * or when the budget elapses. Failures are reported as failed assertions, never thrown.
 * @param smoke - The smoke eval whose assertions are checked.
 * @param output - What the agent produced for the scenario.
 * @param verdict - The agent's rubric verdict.
 * @param notes - Optional free-text notes, included (sanitised) when the verdict is `fail`.
 * @returns A mandatory `behavioural` result: `fail` if any assertion fails or the verdict is `fail`.
 */
export async function recordBehaviouralResult(
  smoke: SmokeEval,
  output: string,
  verdict: "pass" | "fail",
  notes?: string,
): Promise<EvalResult> {
  const started = Date.now();
  const tooLong = output.length > MAX_BEHAVIOURAL_OUTPUT_CHARS;
  const failures: (string | undefined)[] = smoke.assertions.map(() => undefined);
  const toRun: { at: number; pattern: string }[] = [];
  smoke.assertions.forEach((a, at) => {
    if (a.type === "contains" && !output.includes(a.value)) {
      failures[at] = "output does not contain it";
    } else if (a.type === "not-contains" && output.includes(a.value)) {
      failures[at] = "output contains it";
    } else if (a.type === "regex" || a.type === "not-regex") {
      const unsafe = unsafeReason(a.value);
      if (unsafe !== null) {
        failures[at] = `unsafe regular expression (${unsafe})`;
        return;
      }
      try {
        new RegExp(a.value);
      } catch (err) {
        failures[at] = `invalid regular expression (${sanitiseForMessage((err as Error).message)})`;
        return;
      }
      if (tooLong) {
        failures[at] =
          `output exceeds ${MAX_BEHAVIOURAL_OUTPUT_CHARS.toLocaleString("en-US")} characters; regex not evaluated`;
        return;
      }
      toRun.push({ at, pattern: a.value });
    }
  });
  const outcomes = await evaluateRegexes(
    toRun.map((t) => t.pattern),
    output,
  );
  toRun.forEach(({ at }, i) => {
    const o = outcomes[i] as RegexOutcome;
    const type = (smoke.assertions[at] as { type: string }).type;
    if ("error" in o) failures[at] = sanitiseForMessage(o.error);
    else if (type === "regex" && !o.matched) failures[at] = "output does not match";
    else if (type === "not-regex" && o.matched) failures[at] = "output matches";
  });
  const messages: string[] = [];
  smoke.assertions.forEach((a, at) => {
    const reason = failures[at];
    if (reason !== undefined) {
      messages.push(`assertion ${a.type} "${sanitiseForMessage(a.value)}" failed: ${reason}`);
    }
  });
  if (verdict === "fail") {
    messages.push(
      notes ? `agent verdict: fail (${sanitiseForMessage(notes)})` : "agent verdict: fail",
    );
  }
  return {
    id: "behavioural",
    outcome: messages.length === 0 ? "pass" : "fail",
    mandatory: true,
    messages,
    durationMs: Date.now() - started,
  };
}

/**
 * Final activation gate (PRD §9.4): the generation evals must allow activation and a behavioural
 * result must exist and not have failed.
 * @param report - The generation evaluation report.
 * @param behavioural - The recorded behavioural result, if any.
 * @returns True when activation is allowed.
 */
export function isActivatable(
  report: EvaluationReport,
  behavioural: EvalResult | undefined,
): boolean {
  return (
    report.activatable && (behavioural?.outcome === "pass" || behavioural?.outcome === "warning")
  );
}
