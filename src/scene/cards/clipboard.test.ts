import { expect, test, vi } from "vite-plus/test";
import { copyText } from "./clipboard.ts";

test("copyText reports success when the clipboard accepts the text", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  expect(await copyText("details", { writeText })).toBe(true);
  expect(writeText).toHaveBeenCalledWith("details");
});

test("copyText reports failure when the clipboard rejects", async () => {
  const writeText = vi.fn().mockRejectedValue(new Error("denied"));
  expect(await copyText("details", { writeText })).toBe(false);
});

test("copyText reports failure when there is no clipboard", async () => {
  expect(await copyText("details", undefined)).toBe(false);
});
