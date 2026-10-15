import { memo, useEffect, useRef, useState } from "react";
import { useStore } from "../app/store/index.ts";
import { SPEEDS } from "../data/clock.ts";
import { ANCHOR_MS, createMockSource } from "../data/mock.ts";
import {
  LIVE_WINDOW,
  activeSessions,
  coolingDuty,
  cost,
  hallHeat,
  hallInlet,
  hotAisle,
  hottestHall,
  tokensPerMin,
  tokensTotal,
  type Metric,
  type MetricsState,
} from "../data/metrics.ts";
import {
  NO_EVENTS,
  noSessionsText,
  peekEvents,
  sessionList,
  totalInvalid,
} from "../data/reduce.ts";
import { SCENARIOS } from "../data/scenarios.ts";
import { MetricValue } from "../ui/MetricValue.tsx";
import { countPanelRender } from "./dataPanelStats.ts";

const SAMPLE_MS = 250;
const BUTTON =
  "mt-2 w-full rounded-control border border-white/12 px-2 py-1 text-caption text-text-2 hover:text-text";

// The slice parts the panel shows. Refs only change when a batch commits; `time` is the mock
// clock's whole sim second, which moves on its own between batches.
function pick() {
  const s = useStore.getState();
  const now = s.source.name === "mock" ? s.clock?.now() : undefined;
  return {
    source: s.source,
    health: s.dataHealth,
    sessions: s.sessions,
    subagents: s.subagents,
    rates: s.rates,
    tokens: s.tokens,
    modelTokens: s.modelTokens,
    unknownSessions: s.unknownSessions,
    // The source clock's whole second: what the metrics are read at.
    at: s.clock ? Math.floor(s.clock.now() / 1000) * 1000 : 0,
    ring: s.ring,
    version: s.ringVersion,
    time: now === undefined ? ANCHOR_MS : Math.floor(now / 1000) * 1000,
    clock: { speed: s.speed, paused: s.paused, locked: s.locked },
  };
}
type Snapshot = ReturnType<typeof pick>;
const same = (a: Snapshot, b: Snapshot) =>
  a.source === b.source &&
  a.health === b.health &&
  a.sessions === b.sessions &&
  a.subagents === b.subagents &&
  a.rates === b.rates &&
  a.tokens === b.tokens &&
  a.modelTokens === b.modelTokens &&
  a.unknownSessions === b.unknownSessions &&
  a.at === b.at &&
  a.version === b.version &&
  a.time === b.time &&
  a.clock.speed === b.clock.speed &&
  a.clock.paused === b.clock.paused &&
  a.clock.locked === b.clock.locked;

// The panel reads the store at most once per SAMPLE_MS, and only when a part it shows changed
// (CEO C39), so a busy source cannot make it re-render per batch. A timer re-checks every
// SAMPLE_MS so the clock time moves while no batch arrives; a paused clock changes nothing.
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
    const poll = setInterval(schedule, SAMPLE_MS);
    schedule();
    return () => {
      unsubscribe();
      clearInterval(poll);
      if (timer !== null) clearTimeout(timer);
    };
  }, []);
  return snap;
}

// Source time as +HH:MM:SS since the sim start: no time zone, so frozen captures match on every
// machine (C56).
function sinceAnchor(ms: number): string {
  const total = Math.max(0, Math.floor((ms - ANCHOR_MS) / 1000));
  const part = (n: number) => String(n).padStart(2, "0");
  return `+${part(Math.floor(total / 3600))}:${part(Math.floor(total / 60) % 60)}:${part(total % 60)}`;
}

// The metrics the section lists, each as [data-metric name, row label, Metric] (spec 3.6). Hall
// rows read the hottest hall.
function hudMetrics(snap: Snapshot, live: boolean): [string, string, Metric][] {
  const state: MetricsState = snap;
  const window = live ? LIVE_WINDOW : undefined;
  const hall = hottestHall(state, snap.at) ?? "";
  return [
    ["tokens", "Tokens", tokensTotal(state, window)],
    ["active-sessions", "Active sessions", activeSessions(state)],
    ["tokens-per-min", "Tokens/min", tokensPerMin(state, snap.at)],
    ["cost", "API-equivalent cost", cost(state, window)],
    ["hall-heat", "Hall heat", hallHeat(state, hall, snap.at)],
    ["hall-inlet", "Hall inlet", hallInlet(state, hall, snap.at)],
    ["hot-aisle", "Hot aisle", hotAisle(state, hall, snap.at)],
    ["cooling-duty", "Cooling duty", coolingDuty(state, snap.at)],
  ];
}

interface Props {
  frozen: boolean;
  seed: number;
  // The scenario the URL asked for; the select starts there.
  scenario: string;
}

// Body of the dev Data section (CEO C42): source switch, health row, newest sessions, and under
// a clicked row its last 20 events from the ring buffer (C32).
export const DataSection = memo(function DataSection({ frozen, seed, scenario }: Props) {
  countPanelRender();
  const snap = useThrottledData();
  const { source, health, sessions, ring, time, clock } = snap;
  const [peekId, setPeekId] = useState<string | null>(null);
  const [chosen, setChosen] = useState(scenario);
  const list = sessionList(sessions);
  const on = source.name === "mock";
  // Under freeze the apply time would differ by machine load, so it is not shown.
  const applyMs = frozen ? "—" : health.lastApplyMs.toFixed(1);
  // A new mock with a fresh clock at the catch-up end, at the speed now in force (C55); the URL
  // is left as it was.
  const connectMock = (name: string) => {
    const { speed } = useStore.getState();
    useStore.getState().connect(createMockSource({ seed, scenario: name, freeze: frozen, speed }));
  };
  const timeText = on ? ` · ${sinceAnchor(time)}` : "";
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
          onClick={() => connectMock(chosen)}
        >
          Mock
        </button>
      </div>
      <label className="mt-2 flex items-center justify-between gap-2 text-text-2">
        Scenario
        <select
          data-testid="data-scenario"
          value={chosen}
          disabled={source.name !== null && !on}
          className="rounded-control border border-white/12 bg-transparent px-1 text-text-2"
          onChange={(event) => {
            setChosen(event.target.value);
            connectMock(event.target.value);
          }}
        >
          {SCENARIOS.map((s) => (
            <option key={s.name} value={s.name}>
              {s.name}
            </option>
          ))}
        </select>
      </label>
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          data-testid="data-playpause"
          disabled={clock.locked}
          className={BUTTON.replace("mt-2 ", "")}
          onClick={() => (clock.paused ? useStore.getState().play() : useStore.getState().pause())}
        >
          {clock.paused ? "Play" : "Pause"}
        </button>
        {SPEEDS.map((speed) => (
          <button
            key={speed}
            type="button"
            data-testid={`data-speed-${speed}`}
            aria-pressed={clock.speed === speed}
            disabled={clock.locked}
            className={BUTTON.replace("mt-2 ", "")}
            onClick={() => useStore.getState().setSpeed(speed)}
          >
            {speed}x
          </button>
        ))}
      </div>
      <p className="mt-2 text-text-2" data-testid="data-health">
        source {source.name ?? "off"} · {source.status} · applied {health.applied} · batches{" "}
        {health.batches} · last {health.lastBatchSize} / {applyMs} ms · invalid{" "}
        {totalInvalid(health)} · dup {health.duplicates}
        {timeText}
        {on ? ` · ${clock.speed}x · ${clock.paused ? "paused" : "running"}` : ""}
        {health.failedBatches > 0 ? ` · failed ${health.failedBatches}` : ""}
      </p>
      <dl className="m-0 mt-2 text-text-2" data-testid="data-metrics">
        {hudMetrics(snap, source.name === "live").map(([name, label, metric]) => (
          <div key={name} className="flex justify-between gap-2">
            <dt>{label}</dt>
            <dd className="m-0">
              <MetricValue name={name} metric={metric} />
            </dd>
          </div>
        ))}
      </dl>
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
