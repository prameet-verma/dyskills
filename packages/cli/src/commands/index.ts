import { assessCommand } from "./assess";
import { clarifyAnswerCommand, clarifyAskCommand } from "./clarify";
import { contextRequestCommand, contextSubmitCommand } from "./context";
import { discoverCommand } from "./discover";
import { sufficiencyApproveCommand, sufficiencySubmitCommand } from "./sufficiency";
import type { CommandDef } from "./types";

/**
 * Every registered command, in help order. Adding a command means appending its definition here;
 * the wrapper in `run.ts` supplies locking, deadline, state machine, stage timing, save and output.
 */
export const COMMANDS: CommandDef[] = [
  assessCommand,
  discoverCommand,
  contextRequestCommand,
  contextSubmitCommand,
  sufficiencySubmitCommand,
  sufficiencyApproveCommand,
  clarifyAskCommand,
  clarifyAnswerCommand,
];
