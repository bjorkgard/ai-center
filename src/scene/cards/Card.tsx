import type { ReactNode } from "react";
import { GlassPanel } from "../../ui/GlassPanel.tsx";

// Glass card on GlassPanel (04b). role="alert" is read once and does not move focus (DR14).
export function Card(props: {
  title: string;
  body: string;
  actions: ReactNode;
  children?: ReactNode;
  testId: string;
}) {
  return (
    <GlassPanel
      role="alert"
      data-testid={props.testId}
      className="relative w-[420px] max-w-full p-4"
    >
      <div className="flex items-center gap-2">
        <span aria-hidden="true" className="inline-block size-3 shrink-0 bg-status-error" />
        <h2 className="m-0 text-title font-semibold text-text">{props.title}</h2>
      </div>
      <p className="mt-2 mb-0 text-body text-text-2">{props.body}</p>
      <div className="mt-4 flex items-center gap-4">{props.actions}</div>
      {props.children}
    </GlassPanel>
  );
}
