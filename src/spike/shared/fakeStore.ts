import { ledsPerHall, MAX_HALLS, type Load } from "./scene.ts";

export interface FakeStore {
  readonly version: number;
  readonly listenerCount: number;
  tick(): void;
  values(hall: number): Float32Array;
  subscribe(listener: (version: number) => void): () => void;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Seeded LED values in [0,1] for every possible hall, one random-walk step per
// tick. All storage is allocated here; tick() and values() allocate nothing.
export function createFakeStore(opts: { seed: number; load: Load }): FakeStore {
  const perHall = ledsPerHall(opts.load);
  const all = new Float32Array(MAX_HALLS * perHall);
  const slices: Float32Array[] = [];
  for (let h = 0; h < MAX_HALLS; h++) slices.push(all.subarray(h * perHall, (h + 1) * perHall));
  const random = mulberry32(opts.seed);
  for (let i = 0; i < all.length; i++) all[i] = random();
  const listeners: ((version: number) => void)[] = [];
  let version = 0;
  return {
    get version() {
      return version;
    },
    get listenerCount() {
      return listeners.length;
    },
    tick() {
      version++;
      for (let i = 0; i < all.length; i++) {
        const next = all[i] + (random() - 0.5) * 0.4;
        all[i] = next < 0 ? 0 : next > 1 ? 1 : next;
      }
      for (let i = 0; i < listeners.length; i++) listeners[i](version);
    },
    values: (hall) => slices[hall],
    subscribe(listener) {
      listeners.push(listener);
      return () => {
        const at = listeners.indexOf(listener);
        if (at >= 0) listeners.splice(at, 1);
      };
    },
  };
}

export function startTicking(store: FakeStore, hz = 10): () => void {
  const id = setInterval(() => store.tick(), 1000 / hz);
  return () => clearInterval(id);
}

// One colour per LED, 3 floats each. Shared by both views so the per-frame
// write is identical work.
export function writeLedColors(out: Float32Array, values: Float32Array): void {
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    const o = i * 3;
    out[o] = v;
    out[o + 1] = 1 - v * 0.6;
    out[o + 2] = 0.25 + v * 0.15;
  }
}
