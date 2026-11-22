import { describe, expect, it } from "vitest";
import { log, setLogSink, type LogRecord } from "./index";

describe("log", () => {
  it("routes structured records to the sink", () => {
    const seen: LogRecord[] = [];
    const restore = setLogSink((r) => seen.push(r));
    log.info("demo.happened", { id: 1 });
    restore();
    expect(seen).toEqual([{ level: "info", event: "demo.happened", fields: { id: 1 } }]);
  });
});
