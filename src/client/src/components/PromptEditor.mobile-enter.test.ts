import { describe, expect, it } from "vitest";
import { shouldUseMobileEnterNewline } from "./PromptEditor";

describe("PromptEditor mobile Enter behavior", () => {
  it("uses newline mode on coarse pointer / touch devices", () => {
    expect(shouldUseMobileEnterNewline((query) => ({ matches: query === "(pointer: coarse)" }))).toBe(true);
  });

  it("uses newline mode in standalone PWA display mode", () => {
    expect(shouldUseMobileEnterNewline((query) => ({ matches: query === "(display-mode: standalone)" }))).toBe(true);
  });

  it("keeps desktop Enter-to-send behavior when no mobile/PWA query matches", () => {
    expect(shouldUseMobileEnterNewline(() => ({ matches: false }))).toBe(false);
  });
});
