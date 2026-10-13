import type { TestInfo } from "@playwright/test";

// CEO S-RW30: GPU-less CI Firefox may have no WebGL2, so specs that need a rendered
// frame are skipped there and the CI-only smoke asserts the card-or-scene path.
// `vp run e2e:local` has no CI set and runs them in full.
export const isCiFirefox = (browserName: string) => !!process.env.CI && browserName === "firefox";

export function skipFrameSpecInCiFirefox(browserName: string, testInfo: TestInfo) {
  testInfo.skip(
    isCiFirefox(browserName),
    "CEO S-RW30: no WebGL2 frame on CI Firefox; runs in vp run e2e:local",
  );
}
