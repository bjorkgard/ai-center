/// <reference lib="dom" />
import { expect, type Locator, type Page } from "@playwright/test";
import sharp from "sharp";

// The D21 contrast helper (CEO S-RW9, S-RW28): measures text against the pixels actually
// rendered behind it. Chunks 34 and 35 reuse it in forced day, dusk and heatwave.
export const CONTRAST_TEXT = 4.5;
export const CONTRAST_LARGE = 3; // numerals of 28 px and up

type Rgb = [number, number, number];

export function parseRgb(css: string): Rgb {
  const m = css.match(/rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)/);
  if (!m) throw new Error(`cannot read a colour from "${css}"`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

const channel = (v: number) => {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};

export function luminance([r, g, b]: Rgb): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

export interface ContrastSample {
  ratio: number; // the worst pixel in the element's box
  text: Rgb;
  backdrop: Rgb; // the backdrop pixel that gave the worst ratio
}

// Renders the page with the element's text made transparent, so the screenshot shows only
// what lies behind it, then compares every pixel in the element's box with its text colour.
export async function sampleContrast(page: Page, target: Locator): Promise<ContrastSample> {
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (!box) throw new Error("the element has no box to sample");
  const textCss = await target.evaluate((el) => getComputedStyle(el).color);
  const text = parseRgb(textCss);
  const previous = await target.evaluate((el) => {
    const style = (el as HTMLElement).style;
    const old = style.getPropertyValue("color");
    style.setProperty("color", "transparent", "important");
    return old;
  });
  let shot: Buffer;
  try {
    shot = await page.screenshot({ clip: box, animations: "disabled" });
  } finally {
    await target.evaluate((el, old) => {
      const style = (el as HTMLElement).style;
      if (old) style.setProperty("color", old);
      else style.removeProperty("color");
    }, previous);
  }
  const { data, info } = await sharp(shot)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let worst: ContrastSample = { ratio: Infinity, text, backdrop: [0, 0, 0] };
  for (let i = 0; i < info.width * info.height; i++) {
    const px: Rgb = [data[i * 3], data[i * 3 + 1], data[i * 3 + 2]];
    const ratio = contrastRatio(text, px);
    if (ratio < worst.ratio) worst = { ratio, text, backdrop: px };
  }
  return worst;
}

export async function expectContrast(
  page: Page,
  target: Locator,
  options: { large?: boolean } = {},
): Promise<ContrastSample> {
  const sample = await sampleContrast(page, target);
  const min = options.large ? CONTRAST_LARGE : CONTRAST_TEXT;
  expect(
    sample.ratio,
    `text ${sample.text.join(",")} on ${sample.backdrop.join(",")}: ${sample.ratio.toFixed(2)}:1, needs ${min}:1`,
  ).toBeGreaterThanOrEqual(min);
  return sample;
}
