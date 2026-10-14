// A small seeded RNG (mulberry32). Pure and deterministic: chunk 11's mock generator reuses it,
// so the same seed gives the same numbers in the scene's fake load and in mock sessions.
export interface Rng {
  // The next number in [0, 1).
  next(): number;
  // A whole number in [0, n).
  int(n: number): number;
  pick<T>(list: readonly T[]): T;
}

export function createRng(seed: number): Rng {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (n) => Math.floor(next() * n),
    pick: (list) => list[Math.floor(next() * list.length)],
  };
}

// A stateless draw in [0, 1) from whole-number inputs: the same inputs always give the same
// number, whatever was drawn before. For closed forms in scene time and seed.
export function hash01(...parts: number[]): number {
  let h = 0x811c9dc5;
  for (const part of parts) {
    h = Math.imul(h ^ (part | 0), 0x01000193);
    h ^= h >>> 15;
    h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13;
  }
  h = Math.imul(h ^ (h >>> 16), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
