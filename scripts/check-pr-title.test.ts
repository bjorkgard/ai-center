import { describe, expect, test } from "vite-plus/test";
import { checkPrTitle } from "./check-pr-title.ts";

describe("checkPrTitle", () => {
  test.each([
    "feat: add release pipeline",
    "fix(deps): bump react",
    "feat!: drop the old layout",
    "refactor(ui)!: rename panels",
    "chore: tidy",
  ])("accepts %s", (title) => {
    expect(checkPrTitle(title)).toEqual([]);
  });

  test.each([
    "",
    "Add release pipeline",
    "feature: add release pipeline",
    "feat add release pipeline",
    "feat:",
    "feat:no space",
    "Feat: capitalised",
  ])("rejects %j", (title) => {
    expect(checkPrTitle(title)).toHaveLength(1);
  });
});
