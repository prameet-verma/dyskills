import type {
  JsonObject,
  NativeQuestionInput,
  NativeQuestionPlan,
} from "@dynamic-skills/adapter-sdk";

const MAX_PER_CALL = 3;

/**
 * Maps clarification questions onto Codex's `request_user_input` tool: 2-3 options, single
 * select, at most three questions per call. Everything else is asked as text.
 *
 * @param questions - The questions to ask.
 * @returns Calls, text-only ids and the native-id map.
 */
export function codexQuestions(questions: readonly NativeQuestionInput[]): NativeQuestionPlan {
  const textOnly: string[] = [];
  const eligible: (NativeQuestionInput & {
    options: NonNullable<NativeQuestionInput["options"]>;
  })[] = [];
  for (const q of questions) {
    if (
      q.options !== undefined &&
      q.options.length >= 2 &&
      q.options.length <= 3 &&
      q.multiSelect !== true
    ) {
      eligible.push({ ...q, options: q.options });
    } else textOnly.push(q.id);
  }
  const idMap: Record<string, string> = {};
  const calls: JsonObject[] = [];
  for (let i = 0; i < eligible.length; i += MAX_PER_CALL) {
    calls.push({
      questions: eligible.slice(i, i + MAX_PER_CALL).map((q) => {
        const id = q.id.replaceAll("-", "_");
        idMap[id] = q.id;
        return {
          id,
          header: q.id.slice(0, 12),
          question: q.text,
          options: q.options.map((o) => ({ label: o.label, description: o.description })),
        };
      }),
    });
  }
  return {
    tool: "request_user_input",
    calls,
    textOnly,
    idMap,
    notes: [
      "Plan mode only, never in subagents or `codex exec`: otherwise ask in plain text and end the turn.",
    ],
  };
}
