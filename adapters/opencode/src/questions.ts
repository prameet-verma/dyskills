import type {
  JsonObject,
  NativeQuestionInput,
  NativeQuestionPlan,
} from "@dynamic-skills/adapter-sdk";

/** OpenCode's documented header limit for the `question` tool. */
const HEADER_MAX = 30;

/** Most de-duplication attempts before giving up and reusing a numeric tail. */
const MAX_SUFFIX = 99_999;

/**
 * Picks a header for `id` that is not already in `used`, never longer than 30 characters: the
 * first 30 characters of `id`, or, if that collides with an earlier question's header (two ids
 * sharing the same 30-character prefix), as many leading characters of `id` as fit alongside a
 * `~2`, `~3`, … suffix (`id.slice(0, 30 - suffix.length) + suffix`), so no question's native id is
 * ever dropped silently by a collision, and the header never exceeds the tool's limit.
 *
 * @param id - The question id.
 * @param used - Headers already assigned to earlier questions in this call.
 * @returns A header not in `used`, at most 30 characters long.
 */
function uniqueHeader(id: string, used: ReadonlySet<string>): string {
  const header = id.slice(0, HEADER_MAX);
  if (!used.has(header)) return header;
  for (let n = 2; n <= MAX_SUFFIX; n++) {
    const suffix = `~${n}`;
    const candidate = id.slice(0, HEADER_MAX - suffix.length) + suffix;
    if (!used.has(candidate)) return candidate;
  }
  // Exhausted every suffix up to five digits (tens of thousands of colliding ids): fall back to a
  // header that is merely very unlikely to collide, rather than looping forever or growing past 30.
  const suffix = `~${Date.now() % 100_000}`;
  return id.slice(0, Math.max(0, HEADER_MAX - suffix.length)) + suffix;
}

/**
 * Maps clarification questions onto OpenCode's `question` tool: every question that has options
 * is sent in one call (OpenCode documents no cap on the number of questions or options), with
 * `multiple` set from `multiSelect`. A question without options is asked as plain text, so no
 * option is ever dropped. The native id OpenCode's payload exposes is the header; when two ids
 * share their first 30 characters, the later one gets a `~2`, `~3`, … suffix so neither header is
 * lost, and `idMap` maps each final, unique header back to its question id.
 *
 * @param questions - Questions in the order they should be asked.
 * @returns The tool call, text-only ids, header-to-id map and notes.
 */
export function mapQuestions(questions: readonly NativeQuestionInput[]): NativeQuestionPlan {
  const textOnly: string[] = [];
  const idMap: Record<string, string> = {};
  const native: JsonObject[] = [];
  const used = new Set<string>();
  for (const q of questions) {
    if (q.options === undefined) {
      textOnly.push(q.id);
      continue;
    }
    const header = uniqueHeader(q.id, used);
    used.add(header);
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
