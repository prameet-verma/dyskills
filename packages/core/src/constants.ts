/**
 * Active processing budget in milliseconds (PRD §9.1). Active time is wall-clock time since
 * session start minus human-wait pauses (PRD §9.2); clarification never resets it.
 */
export const DEFAULT_BUDGET_MS = 60_000;

/** Maximum clarification rounds per session before continuing on assumptions (PRD §9.3, §9.4). */
export const MAX_CLARIFICATION_ROUNDS = 3;

/**
 * Maximum evaluation attempts per generated skill: the initial attempt plus two revisions.
 * Bounds the generate/evaluate loop so it can never retry indefinitely (PRD §8.4).
 */
export const MAX_EVAL_ATTEMPTS = 3;

/** Estimated-token count of `SKILL.md` above which a conciseness warning is raised (PRD §8.5). */
export const SKILL_TOKEN_SOFT_LIMIT = 2000;

/**
 * Estimated-token count of `SKILL.md` above which evaluation fails and review is mandatory (PRD
 * §8.5).
 */
export const SKILL_TOKEN_HARD_LIMIT = 5000;

/** Maximum concurrent discovery probes (PRD §9.7). */
export const DISCOVERY_CONCURRENCY = 4;

/** Maximum concurrent evaluations (PRD §9.7). */
export const EVAL_CONCURRENCY = 6;
