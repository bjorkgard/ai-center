export interface ComposerState {
  failed: boolean;
  gen: number;
}

export const INITIAL_COMPOSER: ComposerState = { failed: false, gen: 0 };

export interface ComposerDeps {
  log: (line: string) => void;
  unbind: () => void;
}

// A composer error turns bloom off and keeps the scene running; it never raises a card (S-RW10).
export function composerFailed(
  state: ComposerState,
  error: unknown,
  { log, unbind }: ComposerDeps,
): ComposerState {
  log(`composer failed, bloom off: ${error instanceof Error ? error.message : String(error)}`);
  unbind();
  return markComposerFailed(state);
}

// The pure part, for a functional state update that must not repeat the side effects.
export function markComposerFailed(state: ComposerState): ComposerState {
  return { ...state, failed: true };
}

// A context restore remounts the composer under a new key; a failed rebuild lands in
// composerFailed again instead of leaving a black canvas (S-RW31).
export function composerRestored(state: ComposerState): ComposerState {
  return { failed: false, gen: state.gen + 1 };
}
