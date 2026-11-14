import { describe, expect, it } from "vitest";
import { sanitizeExcerpt } from "../src/index";

describe("sanitizeExcerpt", () => {
  it("redacts secrets, keeps newlines and angle brackets, truncates", () => {
    expect(sanitizeExcerpt("a\r\nghp_" + "a".repeat(36) + "\n<T>", 100)).toEqual({
      excerpt: "a\n[REDACTED]\n<T>",
      truncated: false,
    });
    expect(sanitizeExcerpt("x".repeat(7000), 6000)).toEqual({
      excerpt: "x".repeat(6000),
      truncated: true,
    });
  });

  it("removes control characters except newline and tab", () => {
    expect(sanitizeExcerpt("a\u0000b\u001b[0m\tc\nd\u007f", 100).excerpt).toBe("ab[0m\tc\nd");
  });

  it("redacts a multi-line private key including its body", () => {
    const pem =
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\nMIIabc\n-----END RSA PRIVATE KEY-----";
    const out = sanitizeExcerpt(`before\n${pem}\nafter`, 1000).excerpt;
    expect(out).toBe("before\n[REDACTED]\nafter");
    expect(out).not.toContain("MII");
  });

  it("redacts a token split by a control character", () => {
    expect(sanitizeExcerpt("ghp_\u0001" + "a".repeat(36), 100).excerpt).toBe("[REDACTED]");
  });
});
