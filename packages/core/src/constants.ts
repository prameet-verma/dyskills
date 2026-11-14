/**
 * Active processing budget in milliseconds (PRD §10.1). Active time is wall-clock time since
 * session start minus human-wait pauses (PRD §10.3); clarification never resets it.
 */
export const DEFAULT_BUDGET_MS = 60_000;

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
