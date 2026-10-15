import type { ComponentProps } from "react";
import { expect, test } from "vite-plus/test";
import type { Metric } from "../data/metrics.ts";
import { MetricValue } from "./MetricValue.tsx";

test("MetricValue takes a Metric only: a raw number is a type error", () => {
  type Props = ComponentProps<typeof MetricValue>;
  const metric: Metric = { value: 1, unit: "kW", provenance: "real", basis: "b" };
  const ok: Props = { name: "x", metric };
  // @ts-expect-error a bare number is not a Metric
  const bad: Props = { name: "x", metric: 5 };
  expect([ok.name, bad.name]).toEqual(["x", "x"]);
});
