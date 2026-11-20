/**
 * Active processing budget in milliseconds (PRD §10.1). Active time is wall-clock time since
 * session start minus human-wait pauses (PRD §10.3); clarification never resets it. Raised from
 * 60 s to 150 s after the Phase 2 live smoke measured real subagent delegation (PRD v0.9).
 */
export const DEFAULT_BUDGET_MS = 150_000;

/** Maximum clarification rounds per session before continuing on assumptions (PRD §10.4, §10.6). */
export const MAX_CLARIFICATION_ROUNDS = 3;

/**
 * Maximum evaluation attempts per generated skill: the initial attempt plus two revisions.
 * Bounds the generate/evaluate loop so it can never retry indefinitely (PRD §9.4).
 */
export const MAX_EVAL_ATTEMPTS = 3;

/** Estimated-token count of `SKILL.md` above which a conciseness warning is raised (PRD §9.5). */
export const SKILL_TOKEN_SOFT_LIMIT = 2000;

/**
 * Estimated-token count of `SKILL.md` above which evaluation fails and review is mandatory (PRD
 * §9.5).
 */
export const SKILL_TOKEN_HARD_LIMIT = 5000;

/** Maximum concurrent discovery probes (PRD §10.2). */
export const DISCOVERY_CONCURRENCY = 4;

/** Maximum concurrent evaluations (PRD §10.2). */
export const EVAL_CONCURRENCY = 6;

/** Version of every persisted or exchanged document; a breaking change bumps it (PRD §6.6, §13.2). */
export const CONTRACT_VERSION = "1";

/**
 * Maximum targeted context-request rounds per session. Our bound: PRD §6.7 and §6.8 only require
 * requests to be "targeted, bounded". Separate from human clarification rounds.
 */
export const MAX_CONTEXT_REQUEST_ROUNDS = 3;

/** Maximum files requested per context-request round. Our bound (PRD §6.7, §6.8). */
export const MAX_CONTEXT_REQUEST_FILES = 8;

/** Maximum characters of one relevant-file excerpt in the Context Packet. Our bound (PRD §6.7). */
export const MAX_EXCERPT_CHARS = 6_000;

/** Maximum characters of one instruction-file excerpt in the Context Packet. Our bound (PRD §6.7). */
export const MAX_INSTRUCTION_EXCERPT_CHARS = 2_000;

/** Maximum estimated tokens of a whole Context Packet. Our bound (PRD §6.7, §6.8). */
export const MAX_PACKET_TOKENS = 16_000;

/** Maximum accepted `context submit` calls per session. Our bound (PRD §6.8). */
export const MAX_ANALYSIS_SUBMISSIONS = 4;

/** Maximum items in any array of a Context Analysis Result. Our bound (PRD §6.5). */
export const MAX_ANALYSIS_LIST_ITEMS = 50;

/** Maximum entries in each aspect list of a Skill Sufficiency Assessment. Our bound (PRD §5.5). */
export const MAX_SUFFICIENCY_ASPECTS = 20;

/**
 * Largest existing `SKILL.md` or instruction file read as a reusable base, in bytes. The skills
 * scan skips a bigger `SKILL.md` with a warning, and a base read refuses one. Our bound: a
 * skill over 5,000 tokens (~20 KB) already fails review, so this only stops hostile files.
 */
export const MAX_BASE_FILE_BYTES = 200_000;

/** Name of the bootstrap skill itself; it is never a candidate, a base or a duplicate. */
export const BOOTSTRAP_SKILL_NAME = "dynamic-skill-bootstrap";

/** Shown to the agent whenever the pipeline ends without a skill (PRD §10.7). */
export const FALLBACK_MESSAGE = "Continue the original task with existing capabilities.";

/** Notice returned with a reused (sufficient) existing skill. */
export const REUSE_NOTICE = "Load this existing skill unchanged and continue the original task.";

/** Activation notice for a newly generated, ephemeral session skill. */
export const NOTICE_GENERATED =
  "Apply the skill below to the current task. It is ephemeral and lives only in this session.";

/** Activation notice for an augmentation that loads on top of its unchanged base skill. */
export const NOTICE_AUGMENTED =
  "Load the unchanged base skill first, then this augmentation, and apply both to the current task. The augmentation is ephemeral and lives only in this session.";

/** Fewest options a structured question carries (PRD §10.4). */
export const MIN_QUESTION_OPTIONS = 2;

/** Most options a structured question carries: 4 is the largest native limit (PRD §10.4). */
export const MAX_QUESTION_OPTIONS = 4;

/**
 * How long a native skill placement may live, in milliseconds (24 hours). A crashed or abandoned
 * session must not leave a skill listed natively for more than a day.
 */
export const NATIVE_PLACEMENT_TTL_MS = 86_400_000;

/**
 * Context Packet size (estimated tokens, `discover.packetTokens`) below which the root agent writes
 * the analysis itself instead of delegating to the read-only analyst. Delegation costs a subagent
 * start plus a second full pass over the JSON (the analyst cannot write the file), measured at
 * about 35 s on a 1.7k-token packet; reading 6k tokens costs seconds. The bootstrap skill text
 * quotes this value and a test keeps them in sync.
 */
export const INLINE_ANALYSIS_MAX_PACKET_TOKENS = 6000;
