import type {
  JsonObject,
  NativeQuestionInput,
  NativeQuestionPlan,
} from "@dynamic-skills/adapter-sdk";

/** OpenCode's documented header limit for the `question` tool. */
const HEADER_MAX = 30;

/**
 * Maps clarification questions onto OpenCode's `question` tool: every question that has options
 * is sent in one call (OpenCode documents no cap on the number of questions or options), with
 * `multiple` set from `multiSelect`. A question without options is asked as plain text, so no
 * option is ever dropped. The native id OpenCode's payload exposes is the (truncated) header, and
 * `idMap` maps each header back to the question id.
 *
 * @param questions - Questions in the order they should be asked.
 * @returns The tool call, text-only ids, header-to-id map and notes.
 */
export function mapQuestions(questions: readonly NativeQuestionInput[]): NativeQuestionPlan {
  const textOnly: string[] = [];
  const idMap: Record<string, string> = {};
  const native: JsonObject[] = [];
  for (const q of questions) {
    if (q.options === undefined) {
      textOnly.push(q.id);
      continue;
    }
    const header = q.id.slice(0, HEADER_MAX);
    idMap[header] = q.id;
    native.push({
      question: q.text,
      header,
      options: q.options.map((o) => ({ label: o.label, description: o.description })),
      multiple: q.multiSelect ?? false,
    });
  }
  const calls: JsonObject[] = native.length > 0 ? [{ questions: native }] : [];
  return {
    tool: "question",
    calls,
    textOnly,
    idMap,
    notes: [
      "`opencode run` denies (1.x) or cancels (2.x) questions: ask in plain text or record a skipped answer with an assumption.",
    ],
  };
}
