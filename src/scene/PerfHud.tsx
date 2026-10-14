import { useEffect, useState, useSyncExternalStore } from "react";
import { useStore } from "../app/store/index.ts";
import {
  isFakeLoad,
  setFakeLoad,
  setRackCount,
  shownCount,
  subscribeRacks,
} from "./hall/racksDev.ts";
import {
  placedHalls,
  setPlacedHalls,
  setWaypoints,
  showWaypoints,
  subscribeCampus,
} from "./campus/campusDev.ts";
import { MIN_PLACED, SLOT_COUNT } from "./campus/layout.ts";
import { isRoofCut, setRoofCut, subscribeRoof } from "./hall/roof.ts";
import {
  displayedDuty,
  dutyOverride,
  liveDuty,
  setDuty,
  subscribePlant,
} from "./plant/plantDev.ts";
import { SIGN_SLOTS } from "./hall/hallLayout.ts";
import { RACK_SLOTS } from "./hall/rackLayout.ts";
import { hudRows } from "./hud.ts";
import { getSceneProbe, type SceneStats } from "./stats.ts";

const SAMPLE_MS = 250;
const BUTTON =
  "mt-2 w-full rounded-control border border-white/12 px-2 py-1 text-caption text-text-2 hover:text-text";

// Dev perf HUD (S-RW4, DR11): top-right of the safe area, 8 px inset, Geist Mono 12 px
// with tabular numerals, solid fill, no blur. It reads the probe on a timer, not per frame.
// Under the rows, a collapsible Camera section (open at first) holds the glide test, the
// projection toggle and the right-panel toggle. The collapsed sections after it (Hall from
// chunk 06, Racks from chunk 07, Campus from chunk 08, Cooling from chunk 09) each hold one chunk's dev controls (design-review Phase 3 WD14).
export function PerfHud({ frozen }: { frozen: boolean }) {
  const quality = useStore((s) => s.quality);
  const webgl = useStore((s) => s.webgl);
  const rightPanelOpen = useStore((s) => s.rightPanelOpen);
  const [cameraOpen, setCameraOpen] = useState(true);
  const [hallOpen, setHallOpen] = useState(false);
  const [racksOpen, setRacksOpen] = useState(false);
  const [campusOpen, setCampusOpen] = useState(false);
  const [coolingOpen, setCoolingOpen] = useState(false);
  const [rackHall, setRackHall] = useState(0);
  const placed = useSyncExternalStore(subscribeCampus, placedHalls);
  const waypoints = useSyncExternalStore(subscribeCampus, showWaypoints);
  const forced = useSyncExternalStore(subscribePlant, dutyOverride);
  const [live, setLive] = useState<number | null>(null);
  const duty = displayedDuty(forced, live);
  const roofCut = useSyncExternalStore(subscribeRoof, isRoofCut);
  const racks = useSyncExternalStore(subscribeRacks, () => shownCount(rackHall));
  const fakeLoad = useSyncExternalStore(subscribeRacks, isFakeLoad);
  const [view, setView] = useState<{ stats: SceneStats | null; fps: number }>({
    stats: null,
    fps: 0,
  });

  useEffect(() => {
    let last = { frames: 0, at: performance.now() };
    const id = setInterval(() => {
      const stats = getSceneProbe()?.read() ?? null;
      const now = performance.now();
      const frames = stats?.frames ?? 0;
      const fps = frames >= last.frames ? ((frames - last.frames) * 1000) / (now - last.at) : 0;
      last = { frames, at: now };
      setView({ stats, fps });
      setLive(liveDuty());
    }, SAMPLE_MS);
    return () => clearInterval(id);
  }, []);

  const rows = hudRows({ ...view, frozen, quality, webgl });
  const other = view.stats?.projection === "perspective" ? "orthographic" : "perspective";
  return (
    <div
      data-testid="perf-hud"
      className="pointer-events-auto absolute top-2 right-2 rounded-control border border-white/12 bg-bg p-2 font-mono text-caption text-text tabular-nums"
    >
      <dl className="m-0 grid grid-cols-[auto_auto] gap-x-3">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-text-2">{label}</dt>
            <dd className="m-0 text-right" data-hud={label}>
              {value}
            </dd>
          </div>
        ))}
      </dl>
      <section data-testid="dev-camera" className="mt-2 border-t border-white/12 pt-2">
        <button
          type="button"
          aria-expanded={cameraOpen}
          aria-controls="dev-camera-body"
          className="flex w-full items-center justify-between text-caption text-text-2 hover:text-text"
          onClick={() => setCameraOpen(!cameraOpen)}
        >
          Camera
          <span aria-hidden="true">{cameraOpen ? "-" : "+"}</span>
        </button>
        {cameraOpen && (
          <div id="dev-camera-body">
            <button type="button" className={BUTTON} onClick={() => getSceneProbe()?.glideTest()}>
              Glide test
            </button>
            <button
              type="button"
              className={BUTTON}
              onClick={() => getSceneProbe()?.toggleProjection()}
            >
              Switch to {other}
            </button>
            <button
              type="button"
              aria-pressed={rightPanelOpen}
              className={BUTTON}
              onClick={() => useStore.getState().setRightPanelOpen(!rightPanelOpen)}
            >
              {rightPanelOpen ? "Hide" : "Show"} right panel
            </button>
          </div>
        )}
      </section>
      <section data-testid="dev-hall" className="mt-2 border-t border-white/12 pt-2">
        <button
          type="button"
          aria-expanded={hallOpen}
          aria-controls="dev-hall-body"
          className="flex w-full items-center justify-between text-caption text-text-2 hover:text-text"
          onClick={() => setHallOpen(!hallOpen)}
        >
          Hall
          <span aria-hidden="true">{hallOpen ? "-" : "+"}</span>
        </button>
        {hallOpen && (
          <div id="dev-hall-body">
            <button
              type="button"
              aria-pressed={roofCut}
              className={BUTTON}
              onClick={() => setRoofCut(!roofCut)}
            >
              Roof cut {roofCut ? "on" : "off"}
            </button>
          </div>
        )}
      </section>
      <section data-testid="dev-racks" className="mt-2 border-t border-white/12 pt-2">
        <button
          type="button"
          aria-expanded={racksOpen}
          aria-controls="dev-racks-body"
          className="flex w-full items-center justify-between text-caption text-text-2 hover:text-text"
          onClick={() => setRacksOpen(!racksOpen)}
        >
          Racks
          <span aria-hidden="true">{racksOpen ? "-" : "+"}</span>
        </button>
        {racksOpen && (
          <div id="dev-racks-body">
            <label className="mt-2 flex items-center justify-between text-text-2">
              Hall
              <select
                value={rackHall}
                className="rounded-control border border-white/12 bg-bg px-1 text-text"
                onChange={(event) => setRackHall(Number(event.target.value))}
              >
                {Array.from({ length: SIGN_SLOTS }, (_, hall) => (
                  <option key={hall} value={hall}>
                    {String.fromCharCode(65 + hall)}
                  </option>
                ))}
              </select>
            </label>
            <label className="mt-2 flex items-center justify-between gap-2 text-text-2">
              Racks {racks}
              <input
                type="range"
                min={0}
                max={RACK_SLOTS}
                step={1}
                value={racks}
                aria-label="Rack count"
                onChange={(event) => setRackCount(rackHall, Number(event.target.value))}
              />
            </label>
            <button
              type="button"
              aria-pressed={fakeLoad}
              className={BUTTON}
              onClick={() => setFakeLoad(!fakeLoad)}
            >
              Fake load {fakeLoad ? "on" : "off"}
            </button>
          </div>
        )}
      </section>
      <section data-testid="dev-campus" className="mt-2 border-t border-white/12 pt-2">
        <button
          type="button"
          aria-expanded={campusOpen}
          aria-controls="dev-campus-body"
          className="flex w-full items-center justify-between text-caption text-text-2 hover:text-text"
          onClick={() => setCampusOpen(!campusOpen)}
        >
          Campus
          <span aria-hidden="true">{campusOpen ? "-" : "+"}</span>
        </button>
        {campusOpen && (
          <div id="dev-campus-body">
            <label className="mt-2 flex items-center justify-between gap-2 text-text-2">
              Halls {placed}
              <input
                type="range"
                min={MIN_PLACED}
                max={SLOT_COUNT}
                step={1}
                value={placed}
                aria-label="Placed halls"
                onChange={(event) => setPlacedHalls(Number(event.target.value))}
              />
            </label>
            <button
              type="button"
              aria-pressed={waypoints}
              className={BUTTON}
              onClick={() => setWaypoints(!waypoints)}
            >
              Waypoints {waypoints ? "on" : "off"}
            </button>
          </div>
        )}
      </section>
      <section data-testid="dev-cooling" className="mt-2 border-t border-white/12 pt-2">
        <button
          type="button"
          aria-expanded={coolingOpen}
          aria-controls="dev-cooling-body"
          className="flex w-full items-center justify-between text-caption text-text-2 hover:text-text"
          onClick={() => setCoolingOpen(!coolingOpen)}
        >
          Cooling
          <span aria-hidden="true">{coolingOpen ? "-" : "+"}</span>
        </button>
        {coolingOpen && (
          <div id="dev-cooling-body">
            <label className="mt-2 flex items-center justify-between gap-2 text-text-2">
              Duty {duty.toFixed(2)} ({forced === null ? "live" : "set"})
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={duty}
                aria-label="Cooling duty"
                onChange={(event) => setDuty(Number(event.target.value))}
              />
            </label>
          </div>
        )}
      </section>
    </div>
  );
}
