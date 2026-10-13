import { expect, test, vi } from "vite-plus/test";
import { Boundary } from "./View.tsx";

test("the boundary flips to failed on a thrown render error", () => {
  expect(Boundary.getDerivedStateFromError()).toEqual({ failed: true });
});

test("the boundary reports the caught error through onError", () => {
  const onError = vi.fn();
  const boundary = new Boundary({ onError });
  const error = new Error("hall failed to mount");
  boundary.componentDidCatch(error);
  expect(onError).toHaveBeenCalledExactlyOnceWith(error);
});

test("a failed boundary renders nothing, a healthy one its children", () => {
  const boundary = new Boundary({ onError: () => {}, children: "kids" });
  expect(boundary.render()).toBe("kids");
  boundary.state = { failed: true };
  expect(boundary.render()).toBeNull();
});
