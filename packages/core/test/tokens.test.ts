import { expect, it } from "vitest";
import { estimateTokens } from "../src/index";

it("estimates ceil(chars/4)", () => {
  expect(estimateTokens("")).toBe(0);
  expect(estimateTokens("abcd")).toBe(1);
  expect(estimateTokens("abcde")).toBe(2);
});
