import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { maxBytes, readyExpression, viewUrl, views } from "./shots.config.ts";
import {
  checkBuildIdentity,
  checkConsole,
  checkSize,
  ensurePortFree,
  ShotFailed,
} from "./shots.ts";

const html = (version: string) =>
  `<title>Synapse Horizon</title><meta name="app-version" content="${version}">`;

describe("ShotFailed", () => {
  test("an image over the cap names the view and the byte counts", () => {
    const over = Buffer.alloc(maxBytes + 1);
    expect(() => checkSize("home", over)).toThrow(ShotFailed);
    expect(() => checkSize("home", over)).toThrow(
      `view home: ${maxBytes + 1} bytes > ${maxBytes} bytes`,
    );
    expect(() => checkSize("home", Buffer.alloc(maxBytes))).not.toThrow();
  });

  test("a console error names the view and the message", () => {
    expect(() => checkConsole("home", ["boom", "later"])).toThrow(ShotFailed);
    expect(() => checkConsole("home", ["boom"])).toThrow("view home: console error: boom");
    expect(() => checkConsole("home", [])).not.toThrow();
  });

  test("the wrong build identity is refused", () => {
    expect(() => checkBuildIdentity("http://x", html("9.9.9"), "0.1.0")).toThrow(ShotFailed);
    expect(() => checkBuildIdentity("http://x", html("9.9.9"), "0.1.0")).toThrow(
      "app-version 9.9.9, want 0.1.0",
    );
    expect(() => checkBuildIdentity("http://x", "<title>Other</title>", "0.1.0")).toThrow(
      "missing",
    );
    expect(() => checkBuildIdentity("http://x", html("0.1.0"), "0.1.0")).not.toThrow();
  });

  describe("busy port", () => {
    let blocker: Server | undefined;
    afterEach(async () => {
      if (blocker) await new Promise((resolve) => blocker!.close(resolve));
      blocker = undefined;
    });

    test("a port that is already in use is refused", async () => {
      blocker = createServer();
      await new Promise<void>((resolve) => blocker!.listen(0, "127.0.0.1", resolve));
      const { port } = blocker.address() as { port: number };
      await expect(ensurePortFree(port)).rejects.toThrow(ShotFailed);
      await expect(ensurePortFree(port)).rejects.toThrow(`port ${port} is already in use`);
    });
  });
});

describe("shots config", () => {
  test("every entry waits on the scene ready signal (S-RW20)", () => {
    for (const view of views) expect(view.ready).toBe(readyExpression);
    expect(readyExpression).toContain("__sceneReady");
  });

  test("the 04a entry adds dev=1 to the contract URL", () => {
    const entry = views.find((v) => v.file === "docs/img/04a-core.png");
    expect(entry?.query).toBe("dev=1");
    expect(viewUrl("http://x", "home", entry?.query)).toBe(
      "http://x/?source=mock&scenario=steady&seed=1&freeze=1&view=home&dev=1",
    );
    expect(viewUrl("http://x", "home")).toBe(
      "http://x/?source=mock&scenario=steady&seed=1&freeze=1&view=home",
    );
  });

  test("the campus hero is a plain frozen home shot", () => {
    const entry = views.find((v) => v.file === "docs/img/08-campus.png");
    expect(entry).toMatchObject({ name: "home" });
    expect(entry?.query).toBeUndefined();
    expect(entry?.setup).toBeUndefined();
  });

  test("the no-bloom entry forces the medium tier through the dev hook, hides the HUD and waits for a new frame", () => {
    const entry = views.find((v) => v.file === "docs/img/08-campus-nobloom.png");
    expect(entry).toMatchObject({ name: "home", query: "dev=1" });
    expect(entry?.setup).toContain('__sceneDev.setQuality("medium")');
    expect(entry?.setup).toContain("perf-hud");
    expect(entry?.settled).toContain("bloom === false");
    expect(entry?.settled).toContain("frames");
    // Only this entry has a setup step.
    expect(views.filter((v) => v.setup !== undefined)).toHaveLength(1);
  });

  test("the cooling entry is a plain frozen view=cooling shot", () => {
    const entry = views.find((v) => v.file === "docs/img/09-cooling.png");
    expect(entry).toMatchObject({ name: "cooling" });
    expect(entry?.query).toBeUndefined();
    expect(entry?.setup).toBeUndefined();
    expect(viewUrl("http://x", "cooling")).toBe(
      "http://x/?source=mock&scenario=steady&seed=1&freeze=1&view=cooling",
    );
  });

  test("the power entry is a plain frozen view=power shot of the network, under 200 KB", () => {
    const entry = views.find((v) => v.file === "docs/img/10-power-network.png");
    expect(entry).toMatchObject({ name: "power" });
    expect(entry?.query).toBeUndefined();
    expect(entry?.setup).toBeUndefined();
    expect(viewUrl("http://x", "power")).toBe(
      "http://x/?source=mock&scenario=steady&seed=1&freeze=1&view=power",
    );
    expect(maxBytes).toBe(200 * 1024);
  });

  test("the spike entry is gone", () => {
    expect(views.some((v) => v.name.startsWith("spike"))).toBe(false);
  });
});
