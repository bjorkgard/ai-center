import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { maxBytes } from "./shots.config.ts";
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
