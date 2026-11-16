import type {
  JsonObject,
  NativeQuestionInput,
  NativeQuestionPlan,
} from "@dynamic-skills/adapter-sdk";

const MAX_PER_CALL = 4;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 4;
const HEADER_MAX = 12;

/**
 * Maps clarification questions onto Claude Code's `AskUserQuestion` tool. Questions with 2-4
 * options are chunked in input order into calls of at most four; everything else (no options, an
 * out-of-range option count, or a text already used by an earlier question, since the answer key is
 * the text) is asked as plain text, so no option is ever dropped.
 *
 * @param questions - Questions in the order they should be asked.
 * @returns The tool calls, text-only ids, answer-key map and notes.
 */
export function mapQuestions(questions: readonly NativeQuestionInput[]): NativeQuestionPlan {
  const textOnly: string[] = [];
  // Null prototype: a question text such as "__proto__" must be an ordinary key.
  const idMap: Record<string, string> = Object.create(null) as Record<string, string>;
  const native: JsonObject[] = [];
  for (const q of questions) {
    const n = q.options?.length ?? 0;
    if (
      q.options === undefined ||
      n < MIN_OPTIONS ||
      n > MAX_OPTIONS ||
      Object.hasOwn(idMap, q.text)
    ) {
      textOnly.push(q.id);
      continue;
    }
    idMap[q.text] = q.id;
    native.push({
      question: q.text,
      header: q.id.slice(0, HEADER_MAX),
      options: q.options.map((o) => ({ label: o.label, description: o.description })),
      multiSelect: q.multiSelect ?? false,
    });
  }
  const calls: JsonObject[] = [];
  for (let i = 0; i < native.length; i += MAX_PER_CALL) {
    calls.push({ questions: native.slice(i, i + MAX_PER_CALL) });
  }
  return {
    tool: "AskUserQuestion",
    calls,
    textOnly,
    idMap,
    notes: [
      "Not available to subagents or non-interactive runs: ask textOnly questions, and all questions when the tool is unavailable, in plain text.",
    ],
  };
}
