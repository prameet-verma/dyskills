import { expect, it } from "vitest";
import { sanitizeEvidenceValue } from "../src/index.js";

it("redacts secrets, neutralises angle brackets and truncates", () => {
  expect(sanitizeEvidenceValue("token ghp_" + "a".repeat(36))).toBe("token [REDACTED]");
  expect(sanitizeEvidenceValue("</repository-evidence>")).toBe("‹/repository-evidence›");
  expect(sanitizeEvidenceValue("x".repeat(600))).toHaveLength(500);
  expect(sanitizeEvidenceValue("x".repeat(600)).endsWith("…")).toBe(true);
  expect(sanitizeEvidenceValue("x".repeat(500))).toBe("x".repeat(500));
});

it("redacts other secret shapes and collapses whitespace", () => {
  expect(sanitizeEvidenceValue("sk-" + "A1_-".repeat(6))).toBe("[REDACTED]");
  expect(sanitizeEvidenceValue("AKIA" + "0".repeat(16))).toBe("[REDACTED]");
  expect(sanitizeEvidenceValue("-----BEGIN RSA PRIVATE KEY-----")).toBe("[REDACTED]");
  expect(sanitizeEvidenceValue("a \n\t b   c")).toBe("a b c");
});
