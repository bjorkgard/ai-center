import { expect, test } from "@playwright/test";

// Runs in the page: getContext("webgl2") returns null, as in a browser without WebGL2.
const NO_WEBGL2 = `(() => {
  const original = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
    return type === "webgl2" ? null : original.call(this, type, ...rest);
  };
})()`;

// The handled WebGL-unavailable start is not an error: no console.error, no page error.
// Needs no rendered frame, so it also runs in CI Firefox.
const cases = [
  { name: "a browser without WebGL2", url: "/", stub: true },
  { name: "webgl=0", url: "/?webgl=0", stub: false },
];

for (const { name, url, stub } of cases) {
  test(`${name} shows the WebGL card with no console errors`, async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });
    page.on("pageerror", (err) => errors.push(err.message));
    if (stub) {
      await page.addInitScript(NO_WEBGL2);
    }
    await page.goto(url);
    await expect(page.getByRole("alert").filter({ hasText: "could not start 3D" })).toBeVisible();
    expect(errors).toEqual([]);
  });
}
