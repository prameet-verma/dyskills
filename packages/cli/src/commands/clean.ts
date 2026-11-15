import type { SessionCommandDef } from "./types";

/**
 * `clean`: removes the session directory, the only place Phase 1 writes (PRD §11.1). It always
 * works, even on a timed-out session (Ruling R3), and saves nothing afterwards.
 */
export const cleanCommand: SessionCommandDef = {
  name: "clean",
  kind: "session",
  description: "Remove the session directory.",
  options: [],
  step: null,
  stage: null,
  bypassDeadline: true,
  async run({ store, state }) {
    await store.remove(state.id);
    return { data: { removed: true }, save: false, recordStep: false };
  },
};
