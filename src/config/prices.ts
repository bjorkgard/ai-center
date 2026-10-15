// API list prices per million tokens, by model and token class. [estimated] The numbers are
// placeholders kept in one table; a price change is an edit here and a new `asOf`. Cost built
// from them is "API-equivalent cost", never a subscription bill.
export interface Price {
  in: number;
  out: number;
  cacheRead: number;
  cacheWrite: number;
}

// YYYY-MM of the price table.
export const PRICES_AS_OF = "2026-10";

export const PRICES: Readonly<Record<string, Price>> = {
  "claude-sonnet-4": { in: 3, out: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-opus-4": { in: 15, out: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  "claude-haiku-4": { in: 1, out: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  "gpt-5-codex": { in: 1.25, out: 10, cacheRead: 0.125, cacheWrite: 0 },
};

export const priceOf = (model: string | undefined): Price | undefined =>
  model === undefined || !Object.hasOwn(PRICES, model) ? undefined : PRICES[model];
