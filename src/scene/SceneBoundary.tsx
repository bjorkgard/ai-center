import { Component, type ReactNode } from "react";
import { reportContentFailure } from "./failure.ts";

interface Props {
  onError: (error: unknown) => void;
  children?: ReactNode;
}

// Renders nothing once it has caught; the card or the composer fallback lives elsewhere.
export class SceneBoundary extends Component<Props, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    this.props.onError(error);
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

// Inside the Canvas around the scene content: the canvas stays mounted with its last
// frame, the driver stops and the scene-error card goes over the dimmed frame (DR1).
export class SceneContentBoundary extends Component<
  { stopDriver: () => void; children?: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    reportContentFailure(error, this.props.stopDriver);
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}
