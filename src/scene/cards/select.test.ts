import { expect, test } from "vite-plus/test";
import { buildErrorDetails } from "./errorDetails.ts";
import { backdropFor, selectCard } from "./select.ts";

const err = { message: "boom" };

test("no card while everything is fine or restoring", () => {
  expect(selectCard("ok", null, null)).toBeNull();
  expect(selectCard("restoring", null, null)).toBeNull();
});

test("unavailable shows the start or lost card by reason", () => {
  expect(selectCard("unavailable", "start", null)).toBe("webgl-start");
  expect(selectCard("unavailable", "lost", null)).toBe("webgl-lost");
});

test("a scene error shows the scene-error card", () => {
  expect(selectCard("ok", null, err)).toBe("scene-error");
  expect(selectCard("restoring", null, err)).toBe("scene-error");
});

test("precedence: unavailable beats scene error beats restoring", () => {
  expect(selectCard("unavailable", "start", err)).toBe("webgl-start");
  expect(selectCard("unavailable", "lost", err)).toBe("webgl-lost");
  expect(selectCard("restoring", null, err)).toBe("scene-error");
});

test("error details carry the message, scene lines, version and user agent", () => {
  const lines = Array.from({ length: 25 }, (_, i) => `[scene] line ${i}`);
  const text = buildErrorDetails({ message: "boom", lines, version: "1.2.3", userAgent: "UA/9" });
  expect(text).toContain("boom");
  expect(text).toContain("1.2.3");
  expect(text).toContain("UA/9");
  expect(text).toContain("[scene] line 24");
  expect(text).toContain("[scene] line 5");
  expect(text).not.toContain("[scene] line 4\n");
});

test("backdrop: solid while not drawing, 60% dim after a scene error, none otherwise", () => {
  expect(backdropFor("restoring", null)).toBe("solid");
  expect(backdropFor("unavailable", null)).toBe("solid");
  expect(backdropFor("ok", err)).toBe("dim");
  expect(backdropFor("ok", null)).toBeNull();
});
