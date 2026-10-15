import { memo, useEffect, useRef, useState } from "react";
import { useStore } from "../app/store/index.ts";
import { createMockSource } from "../data/mock.ts";
import {
  NO_EVENTS,
  noSessionsText,
  peekEvents,
  sessionList,
  totalInvalid,
} from "../data/reduce.ts";
import { countPanelRender } from "./dataPanelStats.ts";

const SAMPLE_MS = 250;
const BUTTON =
  "mt-2 w-full rounded-control border border-white/12 px-2 py-1 text-caption text-text-2 hover:text-text";

// The slice parts the panel shows. Refs only change when a batch commits.
function pick() {
  const s = useStore.getState();
  return {
    source: s.source,
    health: s.dataHealth,
    sessions: s.sessions,
    ring: s.ring,
    version: s.ringVersion,
  };
}
type Snapshot = ReturnType<typeof pick>;
const same = (a: Snapshot, b: Snapshot) =>
  a.source === b.source &&
  a.health === b.health &&
  a.sessions === b.sessions &&
  a.version === b.version;

// The panel reads the store at most once per SAMPLE_MS, and only when a part it shows changed
// (CEO C39), so a busy source cannot make it re-render per batch.
function useThrottledData(): Snapshot {
  const [snap, setSnap] = useState(pick);
  const shownRef = useRef(snap);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (timer !== null || same(shownRef.current, pick())) return;
      timer = setTimeout(() => {
        timer = null;
        const next = pick();
        if (same(shownRef.current, next)) return;
        shownRef.current = next;
        setSnap(next);
      }, SAMPLE_MS);
    };
    const unsubscribe = useStore.subscribe(schedule);
    schedule();
    return () => {
      unsubscribe();
      if (timer !== null) clearTimeout(timer);
    };
  }, []);
  return snap;
}

interface Props {
  frozen: boolean;
  seed: number;
}

// Body of the dev Data section (CEO C42): source switch, health row, newest sessions, and under
// a clicked row its last 20 events from the ring buffer (C32).
export const DataSection = memo(function DataSection({ frozen, seed }: Props) {
  countPanelRender();
  const { source, health, sessions, ring } = useThrottledData();
  const [peekId, setPeekId] = useState<string | null>(null);
  const list = sessionList(sessions);
  const on = source.name === "mock";
  // Under freeze the apply time would differ by machine load, so it is not shown.
  const applyMs = frozen ? "—" : health.lastApplyMs.toFixed(1);
  return (
    <div id="dev-data-body" data-testid="dev-data-body">
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          aria-pressed={!on}
          data-testid="data-source-off"
          className={BUTTON.replace("mt-2 ", "")}
          onClick={() => useStore.getState().disconnect()}
        >
          Off
        </button>
        <button
          type="button"
          aria-pressed={on}
          data-testid="data-source-mock"
          className={BUTTON.replace("mt-2 ", "")}
          onClick={() =>
            useStore
              .getState()
              .connect(createMockSource({ seed, scenario: "steady", freeze: frozen }))
          }
        >
          Mock
        </button>
      </div>
      <p className="mt-2 text-text-2" data-testid="data-health">
        source {source.name ?? "off"} · {source.status} · applied {health.applied} · batches{" "}
        {health.batches} · last {health.lastBatchSize} / {applyMs} ms · invalid{" "}
        {totalInvalid(health)} · dup {health.duplicates}
        {health.failedBatches > 0 ? ` · failed ${health.failedBatches}` : ""}
      </p>
      {list.rows.length === 0 ? (
        <p className="mt-2 text-text-2" data-testid="data-empty">
          {noSessionsText(source.status)}
        </p>
      ) : (
        <ul className="m-0 mt-2 list-none p-0" data-testid="data-sessions">
          {list.rows.map((row) => (
            <li key={row.sessionId}>
              <button
                type="button"
                data-testid="data-session-row"
                aria-expanded={peekId === row.sessionId}
                className="flex w-full justify-between gap-2 text-left text-text-2 hover:text-text"
                onClick={() => setPeekId(peekId === row.sessionId ? null : row.sessionId)}
              >
                <span>
                  {row.sessionId} {row.vendor}
                </span>
                <span>
                  {row.status} {row.events}
                </span>
              </button>
              {peekId === row.sessionId && <PeekList sessionId={row.sessionId} ring={ring} />}
            </li>
          ))}
          {list.more > 0 && (
            <li className="text-text-2" data-testid="data-more">
              +{list.more} more
            </li>
          )}
        </ul>
      )}
    </div>
  );
});

function PeekList({ sessionId, ring }: { sessionId: string; ring: Snapshot["ring"] }) {
  const events = peekEvents(ring, sessionId);
  if (events.length === 0) {
    return (
      <p className="m-0 text-text-2" data-testid="data-peek-empty">
        {NO_EVENTS}
      </p>
    );
  }
  return (
    <ol className="m-0 list-none pl-2 text-text-2" data-testid="data-peek">
      {events.map((e) => (
        <li key={e.id} data-testid="data-peek-event">
          {e.ts.slice(11, 19)} {e.type} {e.toolName ?? "-"} {e.status ?? "-"}
        </li>
      ))}
    </ol>
  );
}
