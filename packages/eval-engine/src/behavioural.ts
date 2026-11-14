import type { EvalResult, EvaluationReport, SmokeEval } from "@dynamic-skills/core";

/**
 * Longest agent output, in characters, that assertions are run against. The output is untrusted;
 * the cap bounds the cost of every substring and regular-expression scan (PRD §9.2).
 */
export const MAX_BEHAVIOURAL_OUTPUT_CHARS = 100_000;

/** Longest assertion regular expression accepted; longer patterns are rejected as unsafe. */
export const MAX_ASSERTION_REGEX_CHARS = 200;

/**
 * Heuristic guard against catastrophic backtracking (ReDoS) in agent-written patterns. Returns a
 * reason when the pattern is over {@link MAX_ASSERTION_REGEX_CHARS} or contains a quantified group
 * that itself contains a quantifier, such as `(a+)+` or `(x*){2,}`. This is deliberately
 * conservative and not a proof of safety: it rejects the classic nested-quantifier shapes and
 * relies on the output cap to bound everything else. Escapes and character classes are skipped.
 * @param pattern - The regular-expression source from `smoke.json`.
 * @returns A human-readable reason, or null when the pattern passes the heuristic.
 */
function unsafeReason(pattern: string): string | null {
  if (pattern.length > MAX_ASSERTION_REGEX_CHARS) {
    return `longer than ${MAX_ASSERTION_REGEX_CHARS} characters`;
  }
  // One flag per open group: does it contain a quantifier (directly or in a nested group)?
  const stack: boolean[] = [];
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
      stack.push(false);
    } else if (c === "+" || c === "*" || c === "{") {
      if (stack.length > 0) stack[stack.length - 1] = true;
    } else if (c === ")") {
      const hasQuantifier = stack.pop() ?? false;
      const next = pattern[i + 1];
      if (hasQuantifier && (next === "+" || next === "*" || next === "{")) {
        return "nested quantifiers";
      }
      if (hasQuantifier && stack.length > 0) stack[stack.length - 1] = true;
    }
  }
  return null;
}

/**
 * Compiles an assertion regex, or explains why it cannot be used.
 * @param pattern - Regular-expression source.
 * @returns The compiled `RegExp`, or an `error` message.
 */
function compile(pattern: string): { re: RegExp } | { error: string } {
  const reason = unsafeReason(pattern);
  if (reason !== null) return { error: `unsafe regular expression (${reason})` };
  try {
    return { re: new RegExp(pattern) };
  } catch (err) {
    return { error: `invalid regular expression (${(err as Error).message})` };
  }
}

/**
 * Records the behavioural smoke result (PRD §9.2, §9.4). The agent ran the scenario and supplies
 * its `output` and its own rubric `verdict`; this function adds the deterministic assertions from
 * `smoke.json`. Both inputs are untrusted: the output is truncated to
 * {@link MAX_BEHAVIOURAL_OUTPUT_CHARS}, and an invalid or unsafe regex is reported as a failed
 * assertion instead of throwing or being run.
 * @param smoke - The smoke eval whose assertions are checked.
 * @param output - What the agent produced for the scenario.
 * @param verdict - The agent's rubric verdict.
 * @param notes - Optional free-text notes, included when the verdict is `fail`.
 * @returns A mandatory `behavioural` result: `fail` if any assertion fails or the verdict is `fail`.
 */
export function recordBehaviouralResult(
  smoke: SmokeEval,
  output: string,
  verdict: "pass" | "fail",
  notes?: string,
): EvalResult {
  const started = Date.now();
  const text = output.slice(0, MAX_BEHAVIOURAL_OUTPUT_CHARS);
  const messages: string[] = [];
  for (const a of smoke.assertions) {
    const label = `assertion ${a.type} "${a.value}" failed`;
    if (a.type === "contains" && !text.includes(a.value)) {
      messages.push(`${label}: output does not contain it`);
    } else if (a.type === "not-contains" && text.includes(a.value)) {
      messages.push(`${label}: output contains it`);
    } else if (a.type === "regex" || a.type === "not-regex") {
      const c = compile(a.value);
      if ("error" in c) messages.push(`${label}: ${c.error}`);
      else if (a.type === "regex" && !c.re.test(text)) {
        messages.push(`${label}: output does not match`);
      } else if (a.type === "not-regex" && c.re.test(text)) {
        messages.push(`${label}: output matches`);
      }
    }
  }
  if (verdict === "fail") {
    messages.push(notes ? `agent verdict: fail (${notes})` : "agent verdict: fail");
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
