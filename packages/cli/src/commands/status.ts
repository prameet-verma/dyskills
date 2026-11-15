import { renderStatus } from "@dynamic-skills/core";
import type { SessionCommandDef } from "./types";

/**
 * `status`: prints the human status block (PRD §10.5) as plain text on stdout. It is read-only:
 * nothing is saved, and it works on any session, including one that timed out (Ruling R3).
 */
export const statusCommand: SessionCommandDef = {
  name: "status",
  kind: "session",
  description: "Print the session status block.",
  options: [],
  step: null,
  stage: null,
  bypassDeadline: true,
  async run({ state, now }) {
    return { data: {}, text: renderStatus(state, now()), save: false, recordStep: false };
  },
};
