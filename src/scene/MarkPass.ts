import { Pass } from "postprocessing";

// A no-op pass placed right after the scene render pass: it only snapshots the
// draw-call count so post-processing calls can be shown separately (S-RW4, S-RW32).
export class MarkPass extends Pass {
  private onMark: () => void;
  constructor(onMark: () => void) {
    super("MarkPass");
    this.needsSwap = false;
    this.onMark = onMark;
  }
  override render(): void {
    this.onMark();
  }
}
