import type { Provenance } from "../data/metrics.ts";

// The glyphs of design D19: solid dot, ring, dashed ring, each in its own grey or amber.
const GLYPH: Record<Provenance, { color: string; ring: boolean; dash?: string }> = {
  real: { color: "#6B7385", ring: false },
  derived: { color: "#8A93A6", ring: true },
  estimated: { color: "#C9A86A", ring: true, dash: "1.6 1.2" },
};

interface Props {
  provenance: Provenance;
  basis: string;
}

// An 8 px glyph in the superscript position of a value. Hover or focus shows the provenance and
// the basis; the glyph is a focus stop so a keyboard reaches the tooltip too.
export function ProvenanceBadge({ provenance, basis }: Props) {
  const g = GLYPH[provenance];
  const text = `${provenance}: ${basis}`;
  return (
    <span
      className="group relative ml-0.5 inline-block align-super outline-none"
      data-provenance={provenance}
      tabIndex={0}
      role="img"
      aria-label={text}
    >
      <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true" className="block">
        {g.ring ? (
          <circle
            cx="4"
            cy="4"
            r="3.25"
            fill="none"
            stroke={g.color}
            strokeWidth="1.5"
            strokeDasharray={g.dash}
          />
        ) : (
          <circle cx="4" cy="4" r="4" fill={g.color} />
        )}
      </svg>
      <span
        role="tooltip"
        className="pointer-events-none absolute right-0 bottom-full z-10 mb-1 hidden w-max max-w-56 rounded-control border border-white/12 bg-bg px-2 py-1 text-left text-caption text-text-2 group-hover:block group-focus:block"
      >
        {text}
      </span>
    </span>
  );
}
