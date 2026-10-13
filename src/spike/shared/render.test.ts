import { expect, test } from "vite-plus/test";
import { ComposerInitError, RENDER, guardComposer } from "./render.ts";

test("guardComposer turns a throwing composer factory into a ComposerInitError", () => {
  expect(() =>
    guardComposer(() => {
      throw new Error("no float buffers");
    }),
  ).toThrow(ComposerInitError);
  try {
    guardComposer(() => {
      throw "plain string";
    });
  } catch (err) {
    expect((err as Error).message).toBe("plain string");
  }
});

test("guardComposer returns what the factory built", () => {
  const built = {};
  expect(guardComposer(() => built)).toBe(built);
});

test("the shared shadow type is PCFShadowMap, not the removed PCFSoftShadowMap", async () => {
  const three = await import("three");
  expect(RENDER.shadow.type).toBe(three.PCFShadowMap);
});
