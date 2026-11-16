import type { Harness } from "@dynamic-skills/core";

/** Where an install or a saved skill lands: the current project or the user's personal config. */
export type InstallScope = "project" | "personal";

/** Any JSON value. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };

/** A JSON object. */
export type JsonObject = { [k: string]: JsonValue };

/** Read-only view of the host: binary lookup and command execution. Injectable in every test. */
export interface HostProbe {
  /** Absolute path of an executable regular file named `bin` on `PATH`, or null. */
  which(bin: string): Promise<string | null>;
  /** Runs `bin` without a shell; never throws (a spawn error is `code: -1`). */
  run(bin: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }>;
}

/** The host environment an adapter plans against. Every directory is a realpath. */
export interface HostEnv {
  /** Realpath of the project root. */
  projectRoot: string;
  /** Realpath of the user's home directory. */
  userHome: string;
  /** Realpath of the dynamic-skills session home. */
  sessionHome: string;
  /** Realpath of the system configuration directory (`/etc` in production). */
  etcDir: string;
  /** Environment variables visible to the host. */
  vars: Readonly<Record<string, string | undefined>>;
  /** Binary lookup and command execution. */
  probe: HostProbe;
}

/** What detection found about a host tool. */
export interface Detection {
  /** The tool is present. */
  installed: boolean;
  /** Parsed `x.y.z` version, or null. */
  version: string | null;
  /** Configuration variant of the tool, or null. */
  variant: string | null;
  /** The version is one the adapter was tested against. */
  tested: boolean;
  /** Human-readable warnings. */
  warnings: string[];
}

/** Fields shared by every planned write. */
export interface WriteBase {
  /** Absolute target path. */
  path: string;
  /** The result may be committed to version control (contains no machine path). */
  committable: boolean;
  /** Why the write exists, shown to the user. */
  purpose: string;
  /**
   * The target's parent must realpath inside this directory: the project root for project files,
   * the session home for session-home writes, null for personal files (symlinked parents allowed).
   */
  within: string | null;
  /** Warn when git does not ignore the target. */
  mustBeIgnored?: boolean;
}

/** One write an install plan asks the executor to perform. */
export type PlannedWrite =
  | (WriteBase & { kind: "file"; content: Buffer })
  | (WriteBase & { kind: "dir" })
  | (WriteBase & {
      kind: "json-merge" | "jsonc-merge";
      patch: JsonObject;
      promote?: { paths: string[][]; key: string };
    });

/** Options for planning an install. */
export interface InstallOptions {
  /** Install scope. */
  scope: InstallScope;
  /** Also place skills natively. */
  native: boolean;
  /**
   * Also write an allow rule that lets `dynamic-skills` run outside the host sandbox, where the
   * host requires one (an opt-in trust decision).
   */
  allowRule: boolean;
  /** Bytes of the bootstrap skill. */
  bootstrapSkill: Buffer;
}

/** A command that checks an installed result. */
export interface VerifyCommand {
  /** Check name. */
  name: string;
  /** Binary to run. */
  bin: string;
  /** Arguments. */
  args: string[];
  /** Stdout must match. */
  expect: RegExp;
}

/** Everything an install will write, plus how to verify it. */
export interface InstallPlan {
  /** Target harness. */
  harness: Harness;
  /** Install scope. */
  scope: InstallScope;
  /** Realpath of the project root. */
  projectRoot: string;
  /** Writes, applied in order. */
  writes: PlannedWrite[];
  /** Notes for the user. */
  notes: string[];
  /** Post-install verification commands. */
  verify: VerifyCommand[];
}

/** Outcome of one planned write. */
export type WriteAction = "create" | "update" | "unchanged" | "conflict";

/** A planned write together with what happened or would happen. */
export interface AppliedWrite {
  /** Target path. */
  path: string;
  /** Action taken or previewed. */
  action: WriteAction;
  /** Purpose copied from the plan. */
  purpose: string;
  /** Committable flag copied from the plan. */
  committable: boolean;
  /** Why, for a conflict. */
  reason?: string;
}

/** Result of {@link verifyInstall}. */
export interface VerifyReport {
  /** All checks passed. */
  ok: boolean;
  /** Individual checks. */
  checks: { name: string; ok: boolean; detail: string }[];
}

/** A directory a harness reads skills from. */
export interface ReadRoot {
  /** Absolute directory. */
  dir: string;
  /** Scope the directory belongs to. */
  scope: InstallScope;
  /** Harnesses that read it. */
  readBy: Harness[];
}

/** A clarification question offered to a native question tool. */
export interface NativeQuestionInput {
  /** Question id. */
  id: string;
  /** Question text. */
  text: string;
  /** 2-4 options. */
  options?: readonly { label: string; description: string }[];
  /** More than one option may be chosen. */
  multiSelect?: boolean;
}

/** How questions map onto a native question tool. */
export interface NativeQuestionPlan {
  /** Native tool name. */
  tool: string;
  /** Tool call payloads. */
  calls: JsonObject[];
  /** Ids of questions to ask as plain text. */
  textOnly: string[];
  /** Native id to question id. */
  idMap: Record<string, string>;
  /** Notes for the user. */
  notes: string[];
}

/** The contract every harness adapter implements. */
export interface HarnessAdapter {
  /** Harness id. */
  readonly id: Harness;
  /** Executable name. */
  readonly binary: string;
  /** Versions the adapter was tested against. */
  readonly testedVersions: readonly string[];
  /** The harness has a native activation placement. */
  readonly nativeActivation: boolean;
  /** Delegation agent. */
  readonly delegation: { agentName: string; readOnly: "enforced" | "instructed" };
  /** Detects the tool. */
  detect(env: HostEnv): Promise<Detection>;
  /** Plans an install. */
  planInstall(env: HostEnv, detection: Detection, opts: InstallOptions): Promise<InstallPlan>;
  /** Where `save` writes. */
  skillRoot(env: HostEnv, scope: InstallScope): string;
  /** Every root this harness reads. */
  readRoots(env: HostEnv): Promise<ReadRoot[]>;
  /** Maps questions onto the native tool (pure). */
  questions(questions: readonly NativeQuestionInput[]): NativeQuestionPlan;
  /** Native placement root inside `env.sessionHome`, or null. */
  nativeSessionRoot(env: HostEnv): string | null;
  /** Notes shown after a save. */
  saveNotes(detection: Detection): string[];
}

/** Hashes of a bundle's files. */
export interface BundleManifest {
  /** Per-file hashes. */
  files: { path: string; sha256: string }[];
  /** Hash over the whole bundle. */
  sha256: string;
}
