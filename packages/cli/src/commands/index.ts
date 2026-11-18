import { activateCommand } from "./activate";
import { assessCommand } from "./assess";
import { clarifyAnswerCommand, clarifyAskCommand } from "./clarify";
import { cleanCommand } from "./clean";
import { compileCommand } from "./compile";
import { contextRequestCommand, contextSubmitCommand } from "./context";
import { discoverCommand } from "./discover";
import { evaluateCommand } from "./evaluate";
import { initCommand } from "./init";
import { evalRecordCommand } from "./record";
import { reportPerfCommand } from "./report";
import { saveCommand } from "./save";
import { statusCommand } from "./status";
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
  compileCommand,
  evaluateCommand,
  evalRecordCommand,
  activateCommand,
  statusCommand,
  cleanCommand,
  reportPerfCommand,
  initCommand,
  saveCommand,
];
