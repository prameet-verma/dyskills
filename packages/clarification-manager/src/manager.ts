import { MAX_CLARIFICATION_ROUNDS, SlaClock } from "@dynamic-skills/core";
import type { Answer, Assumption, Question, SessionState } from "@dynamic-skills/core";
import type { EvidenceRegistry } from "@dynamic-skills/evidence-registry";

/** Why {@link ClarificationManager.ask} refused a question (PRD §10.4). */
export type RejectionReason =
  | "round-limit"
  | "not-material"
  | "answerable-by-evidence"
  | "answerable-by-discovery"
  | "duplicate";

/** Result of {@link ClarificationManager.ask}. */
export interface AskResult {
  /** Questions that start the new round and are now pending. */
  accepted: Question[];
  /** Questions refused, each with the first check that failed. */
  rejected: { id: string; reason: RejectionReason }[];
  /** Clarification round number after the call (unchanged when nothing was accepted). */
  round: number;
}

/** Result of {@link ClarificationManager.answer}. */
export interface AnswerResult {
  /** Keys of the `user.<questionId>` evidence entries added. */
  evidenceAdded: string[];
  /** Assumptions recorded by this call (declined, skipped and unanswered questions). */
  assumptions: Assumption[];
  /** Ids of blocking questions left without an answer; also pushed to `state.blockedBy`. */
  blockingUnresolved: string[];
}

/** Default assumption wording when the user declines and supplies none (PRD §10.6). */
const DEFAULT_ASSUMPTION = {
  assumption: "Proceeding without this information",
  basis: "No answer provided",
  impact: "Skill may not reflect this decision",
} as const;

/** Case-, whitespace- and punctuation-insensitive form used to detect repeated questions. */
function normalize(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Runs bounded clarification rounds (PRD §10.3-10.6): filters questions so the user is only asked
 * what discovery cannot answer, pauses the SLA while waiting, and turns replies into evidence or
 * recorded assumptions.
 *
 * Both methods mutate the `SessionState` passed to the constructor in place; the caller persists
 * it. Time is always an explicit argument so behaviour stays deterministic.
 */
export class ClarificationManager {
  /**
   * Binds the manager to one session and its evidence registry.
   *
   * @param state - Session to mutate (`clarification`, `status`, `sla`, `assumptions`,
   *   `blockedBy`, `metrics.humanWaitMs`).
   * @param registry - Evidence registry consulted by `ask` and extended by `answer`.
   */
  constructor(
    private readonly state: SessionState,
    private readonly registry: EvidenceRegistry,
  ) {}

  /** True while fewer than {@link MAX_CLARIFICATION_ROUNDS} rounds have been used. */
  canAskMore(): boolean {
    return this.state.clarification.round < MAX_CLARIFICATION_ROUNDS;
  }

  /**
   * Proposes a round of questions (PRD §10.4). Each question gets the first failing check, in
   * order: round limit, materiality, verified evidence, pending repository inspection
   * (discovery precedes asking, §10.4 #3), then duplicate text of any earlier or same-call
   * question. If at least one is accepted the round counter advances, the questions become
   * pending, the status is `waiting-for-clarification` and the SLA is paused (§10.3); otherwise
   * no round is consumed and the SLA is untouched.
   *
   * Question ids must be unique across the whole session: an id already asked (in any round or
   * earlier in this call) is rejected as `duplicate`.
   *
   * @param questions - Candidate questions.
   * @param now - Epoch milliseconds.
   * @throws {Error} if a previous round is still pending (checked before any mutation).
   */
  ask(questions: Question[], now: number): AskResult {
    const c = this.state.clarification;
    if (c.pending.length > 0) throw new Error("A clarification round is still pending");
    if (!this.canAskMore()) {
      return {
        accepted: [],
        rejected: questions.map((x) => ({ id: x.id, reason: "round-limit" as const })),
        round: c.round,
      };
    }
    const seen = new Set(c.asked.map((x) => normalize(x.text)));
    const seenIds = new Set(c.asked.map((x) => x.id));
    const accepted: Question[] = [];
    const rejected: AskResult["rejected"] = [];
    for (const question of questions) {
      const reason = this.rejectionFor(question, seen, seenIds);
      if (reason) {
        rejected.push({ id: question.id, reason });
        continue;
      }
      seen.add(normalize(question.text));
      seenIds.add(question.id);
      accepted.push(question);
    }
    if (accepted.length > 0) {
      c.round += 1;
      c.asked.push(...accepted);
      c.pending = accepted;
      this.state.status = "waiting-for-clarification";
      const clock = SlaClock.from(this.state.sla);
      clock.pause(now);
      this.state.sla = clock.snapshot(now);
    }
    return { accepted, rejected, round: c.round };
  }

  private rejectionFor(
    question: Question,
    seen: Set<string>,
    seenIds: Set<string>,
  ): RejectionReason | undefined {
    if (!question.material) return "not-material";
    if (question.evidenceKey && this.registry.isVerified(question.evidenceKey)) {
      return "answerable-by-evidence";
    }
    if (
      this.state.gaps.some(
        (g) => g.requirement === question.requirement && g.resolution === "inspect",
      )
    ) {
      return "answerable-by-discovery";
    }
    if (seenIds.has(question.id) || seen.has(normalize(question.text))) return "duplicate";
    return undefined;
  }

  /**
   * Applies the user's replies (PRD §10.3, §10.6). Resumes the SLA, adds the waited time to
   * `metrics.humanWaitMs` and sets status `resuming`. `answered` becomes verified evidence
   * `user.<questionId>` (origin `user`); `declined` and `skipped` become assumptions and never
   * evidence; pending questions with no reply become `unanswered` assumptions. Blocking
   * questions left unresolved are added to `state.blockedBy`. Existing assumptions (including
   * `not-asked`) are kept. Validation happens first, so an error leaves the state untouched.
   *
   * @param answers - Replies keyed by question id; a later reply for the same id wins.
   * @param now - Epoch milliseconds.
   * @throws {Error} if an answer names a question that is not pending, or is `answered` with a
   *   blank value (both checked before any mutation).
   */
  answer(answers: Answer[], now: number): AnswerResult {
    const c = this.state.clarification;
    // Only the open round can be answered; closed rounds would leave stale blockers/assumptions.
    const known = new Map(c.pending.map((x) => [x.id, x]));
    for (const a of answers) {
      if (!known.has(a.questionId)) throw new Error(`Question ${a.questionId} is not pending`);
      if (a.status === "answered" && (a.value ?? "").trim() === "") {
        throw new Error(`Answer for ${a.questionId} has no value`);
      }
    }
    const byId = new Map(answers.map((a) => [a.questionId, a]));

    const clock = SlaClock.from(this.state.sla);
    const wasWaiting = clock.isPaused() || c.pending.length > 0;
    this.state.metrics.humanWaitMs += clock.resume(now);
    this.state.sla = clock.snapshot(now);
    if (wasWaiting) this.state.status = "resuming";

    const evidenceAdded: string[] = [];
    const assumptions: Assumption[] = [];
    const blockingUnresolved: string[] = [];

    for (const a of byId.values()) {
      const question = known.get(a.questionId) as Question;
      if (a.status === "answered") {
        const key = `user.${a.questionId}`;
        this.registry.add({
          key,
          value: a.value as string,
          category: "user",
          source: "user",
          confidence: "verified",
          revision: this.state.revision,
          origin: "user",
        });
        evidenceAdded.push(key);
      } else {
        assumptions.push({
          questionId: a.questionId,
          question: question.text,
          ...(a.assumption ?? DEFAULT_ASSUMPTION),
          status: a.status,
        });
      }
    }
    for (const question of c.pending) {
      if (byId.has(question.id)) continue;
      assumptions.push({
        questionId: question.id,
        question: question.text,
        ...DEFAULT_ASSUMPTION,
        status: "unanswered",
      });
    }

    // A blocking question is unresolved unless it was answered (declined, skipped or missing).
    for (const question of c.pending) {
      if (question.blocking && byId.get(question.id)?.status !== "answered") {
        blockingUnresolved.push(question.id);
        if (!this.state.blockedBy.includes(question.id)) this.state.blockedBy.push(question.id);
      }
    }

    c.answers.push(...byId.values());
    c.pending = [];
    this.state.assumptions.push(...assumptions);
    return { evidenceAdded, assumptions, blockingUnresolved };
  }
}
