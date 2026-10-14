import { CanvasTexture, SRGBColorSpace } from "three";
import { bindSignTexture } from "../materials.ts";
import { SIGN, SIGN_SLOTS } from "./hallLayout.ts";

export class SignAtlasError extends Error {
  override name = "SignAtlasError";
}

// Geist is font-display: swap (src/styles/tokens.css:1-6), so a fillText before the file arrives
// would draw the fallback and never redraw. The atlas waits for the font, up to this long.
export const SIGN_FONT_TIMEOUT_MS = 3000; // [estimated]

// One shared canvas: 2 columns x 6 rows of one region per hall slot, each region the panel's
// 3.2 x 0.8 aspect at 320 px per world unit.
const COLUMNS = 2;
const ROWS = SIGN_SLOTS / COLUMNS;
const PX_PER_UNIT = 320;
const REGION = { width: SIGN.width * PX_PER_UNIT, height: SIGN.height * PX_PER_UNIT };

// Panel colours: the slate face (#232b3a), --color-text-2, --color-text-3 and a neutral slate
// stripe that chunk 19 turns into the overflow sign colour (WD5).
const FACE = "#232b3a";
const STRIPE = "#3a4559";
const TEXT = "#a3acbd";
const TEXT_DORMANT = "#8a93a6";
const CAP_HEIGHT_EM = 0.71; // Geist capital height as a share of the font size [estimated]
const GAP = 0.1 * PX_PER_UNIT;
const FONTS = { letter: "600", name: "500" } as const;
const FALLBACK = "sans-serif";

interface Context2D {
  fillStyle: string | CanvasGradient | CanvasPattern;
  font: string;
  textBaseline: CanvasTextBaseline;
  textAlign: CanvasTextAlign;
  measureText(text: string): { width: number };
  fillText(text: string, x: number, y: number): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  clearRect(x: number, y: number, w: number, h: number): void;
  save(): void;
  restore(): void;
  beginPath(): void;
  rect(x: number, y: number, w: number, h: number): void;
  clip(): void;
}

interface CanvasLike {
  width: number;
  height: number;
  getContext(kind: "2d"): Context2D | null;
}

export interface AtlasDeps {
  createCanvas(): CanvasLike;
  fonts: { load(font: string): Promise<unknown> } | null;
}

export interface SlotRect {
  col: number;
  row: number;
  // The region in texture coordinates (v up, as flipY textures read it).
  uv: { u: number; v: number; w: number; h: number };
}

export interface SignAtlas {
  readonly texture: CanvasTexture;
  readonly isReady: boolean;
  // Resolves once the font is ready (or the fallback is chosen); never rejects.
  readonly ready: Promise<void>;
  rect(slot: number): SlotRect;
  setSign(slot: number, letter: string, project: string, dormant?: boolean): void;
}

interface Sign {
  letter: string;
  project: string;
  dormant: boolean;
}

function checkSlot(slot: number): void {
  if (!Number.isInteger(slot) || slot < 0 || slot >= SIGN_SLOTS) {
    throw new SignAtlasError(`sign slot ${String(slot)} is outside 0-${SIGN_SLOTS - 1}`);
  }
}

const slotRect = (slot: number): SlotRect => {
  checkSlot(slot);
  const col = slot % COLUMNS;
  const row = Math.floor(slot / COLUMNS);
  return {
    col,
    row,
    uv: { u: col / COLUMNS, v: 1 - (row + 1) / ROWS, w: 1 / COLUMNS, h: 1 / ROWS },
  };
};

export function createSignAtlas(deps: AtlasDeps): SignAtlas {
  const canvas = deps.createCanvas();
  canvas.width = REGION.width * COLUMNS;
  canvas.height = REGION.height * ROWS;
  const ctx = canvas.getContext("2d");
  if (ctx === null) throw new SignAtlasError("the sign canvas has no 2D context");
  const texture = new CanvasTexture(canvas as unknown as HTMLCanvasElement);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 4;

  const signs = new Map<number, Sign>();
  let isReady = false;

  const font = (weight: string, capUnits: number) =>
    `${weight} ${Math.round((capUnits * PX_PER_UNIT) / CAP_HEIGHT_EM)}px Geist, ${FALLBACK}`;

  // Redraws one slot's region only: clear, face, stripe, then the letter, a middle dot and the name.
  function draw(slot: number, sign: Sign): void {
    const { col, row } = slotRect(slot);
    const x0 = col * REGION.width;
    const y0 = row * REGION.height;
    const color = sign.dormant ? TEXT_DORMANT : TEXT;
    ctx!.save();
    ctx!.beginPath();
    ctx!.rect(x0, y0, REGION.width, REGION.height);
    ctx!.clip();
    ctx!.clearRect(x0, y0, REGION.width, REGION.height);
    ctx!.fillStyle = FACE;
    ctx!.fillRect(x0, y0, REGION.width, REGION.height);
    ctx!.fillStyle = STRIPE;
    ctx!.fillRect(
      x0,
      y0 + REGION.height - SIGN.stripe * PX_PER_UNIT,
      REGION.width,
      SIGN.stripe * PX_PER_UNIT,
    );

    ctx!.fillStyle = color;
    ctx!.textBaseline = "alphabetic";
    ctx!.textAlign = "left";
    const baseline = y0 + REGION.height - SIGN.baseline * PX_PER_UNIT;
    let x = x0 + SIGN.margin * PX_PER_UNIT;
    const right = x0 + REGION.width - SIGN.margin * PX_PER_UNIT;

    ctx!.font = font(FONTS.letter, SIGN.letterCap);
    ctx!.fillText(sign.letter, x, baseline);
    x += ctx!.measureText(sign.letter).width;

    const name = sign.dormant ? "No sessions" : sign.project;
    if (name !== "") {
      ctx!.font = font(FONTS.name, SIGN.nameCap);
      x += GAP;
      ctx!.fillText("·", x, baseline);
      x += ctx!.measureText("·").width + GAP;
      let text = name;
      if (x + ctx!.measureText(text).width > right) {
        while (text.length > 0 && x + ctx!.measureText(`${text}…`).width > right) {
          text = text.slice(0, -1);
        }
        text = `${text}…`;
      }
      ctx!.fillText(text, x, baseline);
    }
    ctx!.restore();
    texture.needsUpdate = true;
  }

  async function waitForFont(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), SIGN_FONT_TIMEOUT_MS);
    });
    const load: Promise<"loaded" | "failed"> = deps.fonts
      ? Promise.all([
          deps.fonts.load(`${FONTS.letter} 16px Geist`),
          deps.fonts.load(`${FONTS.name} 16px Geist`),
        ]).then(
          () => "loaded",
          () => "failed",
        )
      : Promise.resolve("failed");
    const outcome = await Promise.race([load, timeout]);
    clearTimeout(timer);
    if (outcome !== "loaded") {
      console.warn(
        `[scene] sign font Geist did not load (${outcome}); drawing the signs with the fallback font`,
      );
    }
  }

  const ready = waitForFont().then(() => {
    isReady = true;
    for (const [slot, sign] of signs) draw(slot, sign);
  });

  return {
    texture,
    get isReady() {
      return isReady;
    },
    ready,
    rect: slotRect,
    setSign(slot, letter, project, dormant = false) {
      checkSlot(slot);
      const sign = { letter, project, dormant };
      signs.set(slot, sign);
      if (isReady) draw(slot, sign);
    },
  };
}

let shared: SignAtlas | null = null;

// The one atlas every hall shares, made on first use so importing this file touches no DOM.
export function getSignAtlas(): SignAtlas {
  if (shared === null) {
    shared = createSignAtlas({
      createCanvas: () => document.createElement("canvas") as unknown as CanvasLike,
      fonts: typeof document !== "undefined" ? document.fonts : null,
    });
    bindSignTexture(shared.texture);
  }
  return shared;
}

// What the app's ready signal waits for. A failure to build the atlas resolves too: the hall
// view throws the same error into the scene-error path, which shows its card.
export function signAtlasReady(): Promise<void> {
  try {
    return getSignAtlas().ready;
  } catch {
    return Promise.resolve();
  }
}
