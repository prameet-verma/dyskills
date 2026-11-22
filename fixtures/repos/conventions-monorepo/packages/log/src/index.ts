export type LogFields = Record<string, unknown>;
export type LogRecord = { level: "info" | "warn" | "error"; event: string; fields: LogFields };
export type LogSink = (record: LogRecord) => void;

// The only place in the repository allowed to touch console: the default sink.
const stdoutSink: LogSink = (record) => {
  console.log(JSON.stringify({ level: record.level, event: record.event, ...record.fields }));
};

let sink: LogSink = stdoutSink;

/** Swap the sink (tests use captureLogs from @acme/testkit). Returns a restore function. */
export function setLogSink(next: LogSink): () => void {
  const previous = sink;
  sink = next;
  return () => {
    sink = previous;
  };
}

function emit(level: LogRecord["level"], event: string, fields: LogFields = {}): void {
  sink({ level, event, fields });
}

/** Structured logging: an event name (`<package>.<snake_case_event>`) plus fields. */
export const log = {
  info: (event: string, fields?: LogFields) => emit("info", event, fields),
  warn: (event: string, fields?: LogFields) => emit("warn", event, fields),
  error: (event: string, fields?: LogFields) => emit("error", event, fields),
};
