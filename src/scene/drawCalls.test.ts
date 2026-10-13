import { expect, test } from "vite-plus/test";
import { DrawCallCounter } from "./drawCalls.ts";

function fakeInfo() {
  return {
    autoReset: true,
    render: { calls: 0 },
    reset() {
      this.render.calls = 0;
    },
  };
}

test("sums every pass of a frame with autoReset off (E10)", () => {
  const info = fakeInfo();
  const counter = new DrawCallCounter(info);
  expect(info.autoReset).toBe(false);
  for (let i = 0; i < 2; i++) {
    counter.begin();
    info.render.calls += 5;
    info.render.calls += 7;
    counter.end();
    expect(counter.calls).toBe(12);
  }
});

test("splits scene and post-processing calls at the scene pass snapshot", () => {
  const info = fakeInfo();
  const counter = new DrawCallCounter(info);
  counter.begin();
  info.render.calls += 9;
  counter.markScene();
  info.render.calls += 3;
  counter.end();
  expect(counter).toMatchObject({ calls: 12, sceneCalls: 9, postCalls: 3 });
});

test("bloom off: no snapshot or snapshot at the end gives post 0", () => {
  const info = fakeInfo();
  const counter = new DrawCallCounter(info);
  counter.begin();
  info.render.calls += 9;
  counter.end();
  expect(counter).toMatchObject({ calls: 9, sceneCalls: 9, postCalls: 0 });
  counter.begin();
  info.render.calls += 4;
  counter.markScene();
  counter.end();
  expect(counter).toMatchObject({ calls: 4, sceneCalls: 4, postCalls: 0 });
});

test("a snapshot from the previous frame does not leak", () => {
  const info = fakeInfo();
  const counter = new DrawCallCounter(info);
  counter.begin();
  info.render.calls += 9;
  counter.markScene();
  info.render.calls += 3;
  counter.end();
  counter.begin();
  info.render.calls += 6;
  counter.end();
  expect(counter).toMatchObject({ calls: 6, sceneCalls: 6, postCalls: 0 });
});
