import { expect, test } from "vite-plus/test";
import { detectBrowser, webglCopy } from "./browser.ts";

const UA = {
  chrome:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  edge: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
  firefox: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:132.0) Gecko/20100101 Firefox/132.0",
  safari:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  other: "SomeBrowser/1.0",
};

test("detectBrowser picks the browser from the user-agent name", () => {
  expect(detectBrowser(UA.chrome)).toBe("chrome");
  expect(detectBrowser(UA.edge)).toBe("edge");
  expect(detectBrowser(UA.firefox)).toBe("firefox");
  expect(detectBrowser(UA.safari)).toBe("safari");
  expect(detectBrowser(UA.other)).toBe("other");
  expect(detectBrowser("")).toBe("other");
});

const HREF = {
  firefox: "https://support.mozilla.org/kb/performance-settings",
  chrome: "https://support.google.com/chrome/",
  edge: "https://support.microsoft.com/microsoft-edge",
  safari: "https://get.webgl.org/",
  other: "https://get.webgl.org/",
} as const;

for (const browser of ["chrome", "edge", "firefox"] as const) {
  test(`${browser} gets the hardware acceleration copy and its own help link`, () => {
    const copy = webglCopy(browser);
    expect(copy.body).toBe("Turn on hardware acceleration, then reload.");
    expect(copy.link.label).toBe("How to turn on hardware acceleration");
    expect(copy.link.href).toBe(HREF[browser]);
  });
}

for (const browser of ["safari", "other"] as const) {
  test(`${browser} gets the update copy and the WebGL test page`, () => {
    const copy = webglCopy(browser);
    expect(copy.body).toBe("Update your browser and system, then reload.");
    expect(copy.link.href).toBe(HREF[browser]);
  });
}
