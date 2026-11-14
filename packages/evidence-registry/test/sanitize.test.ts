import { expect, it } from "vitest";
import { sanitizeEvidenceValue } from "../src/index";

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

it("redacts a whole private key block and other token shapes", () => {
  const pem = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\nabc\n-----END PRIVATE KEY-----";
  expect(sanitizeEvidenceValue(`k ${pem} after`)).toBe("k [REDACTED] after");
  expect(sanitizeEvidenceValue("-----BEGIN RSA PRIVATE KEY-----\nMIIE")).toBe("[REDACTED]");
  expect(sanitizeEvidenceValue("github_pat_" + "A1_".repeat(8))).toBe("[REDACTED]");
  expect(sanitizeEvidenceValue("gho_" + "a".repeat(36))).toBe("[REDACTED]");
  expect(sanitizeEvidenceValue("ghs_" + "a".repeat(36))).toBe("[REDACTED]");
  expect(sanitizeEvidenceValue("ghu_" + "a".repeat(36))).toBe("[REDACTED]");
  expect(sanitizeEvidenceValue("xoxb-1234567890-abc")).toBe("[REDACTED]");
  expect(sanitizeEvidenceValue("xoxp-1234567890-abc")).toBe("[REDACTED]");
});
