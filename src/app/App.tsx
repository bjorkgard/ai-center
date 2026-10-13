import { useState } from "react";
import { SpikePage } from "../spike/SpikePage.tsx";
import { parseSpikeParams } from "../spike/shared/params.ts";

export function App() {
  // Spike views (chunk 03) hang off ?view=spike-*; chunk 04a deletes this branch.
  const [{ spike }] = useState(() => {
    const parsed = parseSpikeParams(window.location.search);
    for (const warning of parsed.warnings) console.warn(`spike params: ${warning}`);
    return parsed;
  });
  if (spike) return <SpikePage params={spike} />;
  return (
    <main className="flex h-full items-center justify-center bg-bg">
      <h1 className="text-kpi font-semibold text-cyan">Synapse Horizon</h1>
    </main>
  );
}
