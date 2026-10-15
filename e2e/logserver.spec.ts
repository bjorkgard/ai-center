/// <reference lib="dom" />
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test, type Page, type WebSocketRoute } from "@playwright/test";

// The live source against the real log server of the logserver project (playwright.config.ts):
// a `vp preview` on its own port watching only e2e/.tmp/logs (PLAN chunk 14c, C70). The specs
// run in order on one worker; the first one needs the directory still empty, as the project's
// webServer leaves it.
test.describe.configure({ mode: "serial" });

const ROOT = resolve("e2e/.tmp/logs");
const STREAM = /\/api\/stream/;
let sequence = 0;
// PLAN: within 1 s. macOS delivers recursive fs.watch events through FSEvents, which measured
// 0.2 to 2.1 s here, so the 1 s bound holds where inotify is used (Linux, CI) and macOS gets 5 s.
const APPEND_MS = process.platform === "darwin" ? 5000 : 1000;

// A fixture log file with `count` lines; every spec uses its own file name.
function fixture(count: number): string {
  mkdirSync(join(ROOT, "proj"), { recursive: true });
  const path = join(ROOT, "proj", `spec-${Date.now()}-${sequence++}.jsonl`);
  writeFileSync(path, Array.from({ length: count }, (_, i) => `{"n":${i}}\n`).join(""));
  return path;
}

const pill = (page: Page) => page.getByTestId("connection-pill");
const banner = (page: Page) => page.getByTestId("connection-banner");
const lineRow = (page: Page, path: string) =>
  page.locator(`[data-testid=data-logline][data-path$="${path.split("/").pop()}"]`);

async function openDataSection(page: Page) {
  await page.locator("[data-testid=dev-data] button").first().click();
  await page.locator("[data-testid=dev-data-body]").waitFor();
}

test("a page without source opens the stream WebSocket", async ({ page }) => {
  const opened = page.waitForEvent("websocket", (ws) => STREAM.test(ws.url()));
  await page.goto("/");
  await opened;
  await expect(pill(page)).toHaveText("Connected");
});

test("D9: empty roots show the first-run card naming the roots, and Try the demo opens the mock", async ({
  page,
}) => {
  await page.goto("/?dev=1");
  const card = page.getByTestId("first-run-card");
  await expect(card).toBeVisible();
  await expect(page.getByTestId("first-run-roots")).toContainText(`${ROOT} (SYNAPSE_LOG_ROOTS)`);
  await expect(card).toContainText("No sessions in the last 24 h");
  await expect(card.getByRole("button")).toHaveText(["Try the demo"]);
  await card.getByRole("button", { name: "Try the demo" }).click();
  await expect(page).toHaveURL(/[?&]source=mock&scenario=steady/);
  await expect(page.getByTestId("first-run-card")).toHaveCount(0);
});

test("an appended line reaches the dev HUD logLines row within 1 s", async ({ page }) => {
  const path = fixture(2);
  await page.goto("/?dev=1");
  await openDataSection(page);
  const metric = lineRow(page, path).locator("[data-metric=logLines]");
  await expect(metric).toContainText("2 lines");
  await expect(metric.locator("[data-provenance=real]")).toHaveAttribute(
    "aria-label",
    "real: whole file; files modified in the last 24 h",
  );
  appendFileSync(path, '{"n":2}\n');
  await expect(metric).toContainText("3 lines", { timeout: APPEND_MS });
  await expect(page.getByTestId("first-run-card")).toHaveCount(0);
});

for (const [mode, text] of [
  ["dev", "Log server not running. Start it with vp dev."],
  ["binary", "Synapse Horizon stopped. Run it again to reconnect."],
  ["preview", "Log server not running. Start it with vp run serve."],
] as const) {
  test(`D11: a refused socket shows the ${mode} banner text`, async ({ page }) => {
    await page.route(
      (url) => url.pathname === "/",
      async (route) => {
        const response = await route.fetch();
        const body = (await response.text()).replace(
          /(name="synapse-mode" content=")[^"]*/,
          `$1${mode}`,
        );
        await route.fulfill({
          response,
          body,
          headers: { ...response.headers(), "content-length": String(Buffer.byteLength(body)) },
        });
      },
    );
    await page.routeWebSocket(STREAM, (ws) => ws.close());
    await page.goto("/");
    await expect(banner(page)).toHaveText(text);
    await expect(pill(page)).toHaveText("Reconnecting");
    await expect(page.getByTestId("first-run-card")).toHaveCount(0);
  });
}

test("a dropped socket shows Reconnecting and the banner, then recovers with the same counts", async ({
  page,
}) => {
  const path = fixture(4);
  let attempts = 0;
  let allow = false;
  let first: WebSocketRoute | undefined;
  await page.routeWebSocket(STREAM, (ws) => {
    attempts++;
    if (attempts > 1 && !allow) return void ws.close();
    ws.connectToServer();
    first ??= ws;
  });
  await page.goto("/?dev=1");
  await openDataSection(page);
  const metric = lineRow(page, path).locator("[data-metric=logLines]");
  await expect(pill(page)).toHaveText("Connected");
  await expect(metric).toContainText("4 lines");
  await expect(banner(page)).toHaveCount(0);

  await first?.close();
  await expect(pill(page)).toHaveText("Reconnecting");
  // The page had a connection, so the banner waits 3 s before it shows.
  await expect(banner(page)).toHaveCount(0);
  await expect(banner(page)).toBeVisible({ timeout: 6000 });
  expect(attempts).toBeGreaterThan(1);
  await expect(metric).toContainText("4 lines");

  allow = true;
  await expect(pill(page)).toHaveText("Connected", { timeout: 15_000 });
  await expect(banner(page)).toHaveCount(0);
  await expect(metric).toContainText("4 lines");
});

test("a wrong token is replaced from /api/session once, without a reload", async ({ page }) => {
  let hellos = 0;
  let loads = 0;
  page.on("load", () => loads++);
  await page.routeWebSocket(STREAM, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => {
      hellos++;
      server.send(
        hellos === 1 ? String(message).replace(/"token":"[^"]*"/, '"token":"x"') : message,
      );
    });
  });
  await page.goto("/");
  await expect(pill(page)).toHaveText("Connected");
  expect(hellos).toBe(2);
  expect(loads).toBe(1);
  await expect(banner(page)).toHaveCount(0);
});

test("a second rejection shows Session expired with a Reload button", async ({ page }) => {
  await page.routeWebSocket(STREAM, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => {
      server.send(String(message).replace(/"token":"[^"]*"/, '"token":"x"'));
    });
  });
  await page.goto("/");
  await expect(banner(page)).toContainText("Session expired. Reload the page.");
  await expect(banner(page).getByRole("button", { name: "Reload" })).toBeVisible();
  await expect(pill(page)).toHaveText("Off");
  await expect(pill(page)).toHaveAttribute("title", "Session expired. Reload the page.");
});

test("pill states and root problems from the server, with no toast and no crash", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let server: WebSocketRoute | undefined;
  await page.routeWebSocket(STREAM, (ws) => {
    server = ws;
    ws.onMessage(() => {
      ws.send(JSON.stringify({ type: "heartbeat" }));
      ws.send(
        JSON.stringify({
          type: "roots",
          roots: [{ path: "/logs", files: 3, source: "flag" }],
        }),
      );
      ws.send(JSON.stringify({ type: "progress", done: 120, total: 480 }));
    });
  });
  await page.goto("/");
  await expect(pill(page)).toHaveText("Catching up 120/480 files");

  server?.send(JSON.stringify({ type: "progress", done: 480, total: 480 }));
  await expect(pill(page)).toHaveText("Connected");

  const reason = "root not found: /nope; set --log-root or SYNAPSE_LOG_ROOTS";
  server?.send(
    JSON.stringify({
      type: "roots",
      roots: [
        { path: "/logs", files: 3, source: "flag" },
        { path: "/nope", files: 0, source: "flag", reason },
      ],
    }),
  );
  await expect(page.getByTestId("pill-reason")).toHaveText(reason);
  await expect(pill(page)).toContainText("Connected");

  server?.send(JSON.stringify({ type: "roots", roots: [] }));
  await expect(pill(page)).toHaveText("Off");

  await expect(page.getByTestId("toast")).toHaveCount(0);
  expect(errors).toEqual([]);
});
