export interface RenderInfoLike {
  autoReset: boolean;
  render: { calls: number };
  reset(): void;
}

// With a composer, three resets renderer.info on every render() call, so one read
// sees only the last pass. autoReset off plus one reset per frame counts them all (E10).
// markScene() snapshots the count after the scene render pass: the scene calls are
// the snapshot, post-processing is the rest (S-RW4). Without a snapshot post is 0.
export class DrawCallCounter {
  calls = 0;
  sceneCalls = 0;
  postCalls = 0;
  private info: RenderInfoLike;
  private snapshot = -1;
  constructor(info: RenderInfoLike) {
    this.info = info;
    info.autoReset = false;
  }
  begin(): void {
    this.info.reset();
    this.snapshot = -1;
  }
  markScene(): void {
    this.snapshot = this.info.render.calls;
  }
  end(): void {
    this.calls = this.info.render.calls;
    this.sceneCalls = this.snapshot < 0 ? this.calls : this.snapshot;
    this.postCalls = this.calls - this.sceneCalls;
  }
}
