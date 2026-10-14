// The packet layer as closed forms (eng-review Phase 3 E26, design-review Phase 3 WD8, D20):
// nothing here simulates. Packet j of a line has travelled 2.5 t + j L / n units at scene time t,
// the line (length L, n packets) wraps it, and a line holds as many as its rate asks for, at most
// 12. All numbers are estimates from the plan.
export const PACKET = {
  // Units a second along the line.
  speed: 2.5,
  // The least distance between two packets of a line (the packet count keeps L / n above it).
  spacing: 1.2,
  // The most packets moving on one line.
  cap: 12,
  radius: 0.08,
  color: "#A5F3FC",
  // Packets a second on each line until the dev control sets another.
  defaultRate: 1,
  maxRate: 10,
  // The share of the speed kept under reduced motion (design D20).
  reducedShare: 0.25,
} as const;

// How many packets a line of `length` holds at `rate` a second: the packets that are on it while
// a packet takes `length / speed` seconds to cross, at least one while the rate is above 0, never
// more than the cap, and never so many that they sit closer than the spacing around the loop.
export function packetCount(length: number, rate: number): number {
  if (!(rate > 0) || !(length > 0)) return 0;
  const wanted = Math.max(1, Math.ceil((rate * length) / PACKET.speed - 1e-9));
  return Math.min(PACKET.cap, Math.floor(length / PACKET.spacing + 1e-9), wanted);
}

// The distance the packets of a line have travelled at scene time t: 2.5 t, a quarter of the 2.5
// under reduced motion. Packet j adds packetGap(L, n) j, and the caller wraps it to the length.
export function packetTravel(t: number, reducedMotion: boolean): number {
  const speed = reducedMotion ? PACKET.speed * PACKET.reducedShare : PACKET.speed;
  return speed * t;
}

// The distance between neighbouring packets of a line of `length` holding `count`: even over the
// whole loop, the wrap gap included, and the same under reduced motion.
export function packetGap(length: number, count: number): number {
  return count > 0 ? length / count : 0;
}

// `distance` brought into 0 to `length`.
export function wrapPhase(distance: number, length: number): number {
  const wrapped = distance % length;
  return wrapped < 0 ? wrapped + length : wrapped;
}
