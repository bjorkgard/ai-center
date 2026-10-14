// Which rack slot a key (a session) stands in, inside one hall. Pure: a key keeps its slot, a new
// key takes the lowest free one, a freed slot is reused only after its key leaves, and a key that
// finds every slot taken waits unslotted and is counted (overflow halls are chunk 19's, D8).
export class SlotAllocator {
  readonly capacity: number;
  private readonly keys: (string | null)[];
  private readonly slots = new Map<string, number>();
  private readonly waiting = new Set<string>();

  constructor(capacity: number) {
    this.capacity = capacity;
    this.keys = Array.from({ length: capacity }, () => null);
  }

  // The key's slot, or null when every slot is taken. Asking again is safe and changes nothing
  // for a key that already has one.
  assign(key: string): number | null {
    const held = this.slots.get(key);
    if (held !== undefined) return held;
    const free = this.keys.indexOf(null);
    if (free < 0) {
      this.waiting.add(key);
      return null;
    }
    this.keys[free] = key;
    this.slots.set(key, free);
    this.waiting.delete(key);
    return free;
  }

  release(key: string): void {
    this.waiting.delete(key);
    const slot = this.slots.get(key);
    if (slot === undefined) return;
    this.keys[slot] = null;
    this.slots.delete(key);
  }

  // Makes the keys in `present` the ones holding slots: the rest leave first, then the new ones
  // arrive in the order given.
  sync(present: readonly string[]): void {
    const wanted = new Set(present);
    for (const key of [...this.slots.keys(), ...this.waiting]) {
      if (!wanted.has(key)) this.release(key);
    }
    for (const key of present) this.assign(key);
  }

  slotOf(key: string): number | null {
    return this.slots.get(key) ?? null;
  }

  keyAt(slot: number): string | null {
    return this.keys[slot] ?? null;
  }

  isUsed(slot: number): boolean {
    return this.keys[slot] != null;
  }

  // Slots in use.
  get used(): number {
    return this.slots.size;
  }

  // One past the highest slot in use: how many instances a mesh must draw.
  get highest(): number {
    return this.keys.findLastIndex((key) => key !== null) + 1;
  }

  // Keys that asked and found no slot.
  get overflow(): number {
    return this.waiting.size;
  }
}
