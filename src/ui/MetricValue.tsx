import { formatMetric, type Metric } from "../data/metrics.ts";
import { ProvenanceBadge } from "./ProvenanceBadge.tsx";

interface Props {
  // The metric's name for tests and the audit; every rendered metric carries data-metric.
  name: string;
  // A Metric only: a bare number does not compile (CEO C75).
  metric: Metric;
}

export function MetricValue({ name, metric }: Props) {
  return (
    <span data-metric={name}>
      {formatMetric(metric)}
      <ProvenanceBadge provenance={metric.provenance} basis={metric.basis} />
    </span>
  );
}
