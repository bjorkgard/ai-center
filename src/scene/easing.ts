// CSS cubic-bezier(x1, y1, x2, y2) as a function of time progress, solved by Newton steps
// with a bisection fallback.
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const coefficient = (a: number, b: number) => ({
    c: 3 * a,
    b: 3 * (b - a) - 3 * a,
    a: 1 - 3 * a - (3 * (b - a) - 3 * a),
  });
  const cx = coefficient(x1, x2);
  const cy = coefficient(y1, y2);
  const at = (k: { a: number; b: number; c: number }, s: number) => ((k.a * s + k.b) * s + k.c) * s;
  const slope = (k: { a: number; b: number; c: number }, s: number) =>
    (3 * k.a * s + 2 * k.b) * s + k.c;

  const solve = (x: number): number => {
    let s = x;
    for (let i = 0; i < 8; i++) {
      const err = at(cx, s) - x;
      if (Math.abs(err) < 1e-7) return s;
      const d = slope(cx, s);
      if (Math.abs(d) < 1e-6) break;
      s -= err / d;
    }
    let lo = 0;
    let hi = 1;
    s = x;
    while (lo < hi && hi - lo > 1e-7) {
      if (at(cx, s) < x) lo = s;
      else hi = s;
      s = (lo + hi) / 2;
    }
    return s;
  };

  return (t) => (t <= 0 ? 0 : t >= 1 ? 1 : at(cy, solve(t)));
}

// The one easing of the app (design D20), the same curve as --ease in tokens.css.
export const ease = cubicBezier(0.22, 1, 0.36, 1);
