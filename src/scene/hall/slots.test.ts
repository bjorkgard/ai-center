import { expect, test } from "vite-plus/test";
import { SlotAllocator } from "./slots.ts";

const keys = (n: number, prefix = "k") => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

test("a key keeps its slot while other keys come and go", () => {
  const slots = new SlotAllocator(16);
  expect(slots.assign("a")).toBe(0);
  expect(slots.assign("b")).toBe(1);
  expect(slots.assign("c")).toBe(2);
  slots.release("b");
  slots.assign("d");
  expect(slots.assign("a")).toBe(0);
  expect(slots.assign("c")).toBe(2);
  expect(slots.slotOf("a")).toBe(0);
});

test("a new key takes the lowest free slot", () => {
  const slots = new SlotAllocator(16);
  for (const key of ["a", "b", "c", "d"]) slots.assign(key);
  slots.release("c");
  slots.release("a");
  expect(slots.assign("e")).toBe(0);
  expect(slots.assign("f")).toBe(2);
  expect(slots.assign("g")).toBe(4);
});

test("a freed slot is reused only after its key leaves", () => {
  const slots = new SlotAllocator(16);
  slots.assign("a");
  slots.assign("b");
  slots.assign("c");
  // b is still here, so a new key cannot take slot 1.
  expect(slots.assign("d")).toBe(3);
  slots.release("b");
  expect(slots.slotOf("b")).toBeNull();
  expect(slots.assign("e")).toBe(1);
});

test("a 17th key gets no slot and is counted once", () => {
  const slots = new SlotAllocator(16);
  for (const key of keys(16)) slots.assign(key);
  expect(slots.overflow).toBe(0);
  expect(slots.assign("k16")).toBeNull();
  expect(slots.assign("k16")).toBeNull();
  expect(slots.assign("k17")).toBeNull();
  expect(slots.overflow).toBe(2);
  expect(slots.used).toBe(16);
  expect(slots.slotOf("k16")).toBeNull();
  // A slot frees up: the waiting key takes it when it asks again, and stops counting.
  slots.release("k3");
  expect(slots.assign("k16")).toBe(3);
  expect(slots.overflow).toBe(1);
  slots.release("k17");
  expect(slots.overflow).toBe(0);
});

test("the same inputs give the same layout", () => {
  const run = () => {
    const slots = new SlotAllocator(16);
    for (const key of keys(10)) slots.assign(key);
    for (const key of ["k2", "k5", "k7"]) slots.release(key);
    for (const key of keys(4, "n")) slots.assign(key);
    return keys(10)
      .concat(keys(4, "n"))
      .map((key) => [key, slots.slotOf(key)]);
  };
  expect(run()).toEqual(run());
});

test("sync releases the keys that left, assigns the new ones in order, and reports the extent", () => {
  const slots = new SlotAllocator(16);
  slots.sync(["a", "b", "c"]);
  expect(slots.highest).toBe(3);
  slots.sync(["a", "c", "d"]);
  expect([slots.slotOf("a"), slots.slotOf("c"), slots.slotOf("d")]).toEqual([0, 2, 1]);
  expect(slots.keyAt(1)).toBe("d");
  expect(slots.isUsed(3)).toBe(false);
  slots.sync([]);
  expect(slots.highest).toBe(0);
  expect(slots.used).toBe(0);
});
