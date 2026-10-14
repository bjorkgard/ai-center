import type { ReactNode } from "react";

// Plain card for 04a: solid --color-bg, 1 px border at 12% white, 10 px radius.
// 04b restyles it with GlassPanel. role="alert" is read once and does not move focus (DR14).
export function Card(props: {
  title: string;
  body: string;
  actions: ReactNode;
  children?: ReactNode;
  testId: string;
}) {
  return (
    <div
      role="alert"
      data-testid={props.testId}
      className="pointer-events-auto w-[420px] max-w-full rounded-panel border border-white/12 bg-bg p-4"
    >
      <div className="flex items-center gap-2">
        <span aria-hidden="true" className="inline-block size-3 shrink-0 bg-status-error" />
        <h2 className="m-0 text-title font-semibold text-text">{props.title}</h2>
      </div>
      <p className="mt-2 mb-0 text-body text-text-2">{props.body}</p>
      <div className="mt-4 flex items-center gap-4">{props.actions}</div>
      {props.children}
    </div>
  );
}
