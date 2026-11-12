/**
 * SPEC helpers for the SECONDARY-TEXT contrast contract (GUI-19).
 *
 * This remote has no background of its own: it is painted on a DARK panel, the
 * host shell's scrim over its animated gradient when federated, or the
 * --hug-bg-0 body when served standalone. Text that hard-codes a mid grey
 * (#555/#666/#777/#888) or sits on a light fill while inheriting light text was
 * measured on that panel at 1.03 to 3.75:1. These helpers compute the WCAG
 * ratio the way a reader sees it: the element's COMPUTED colour against every
 * background between it and the component root, composited over each panel.
 */

/** The dark panels this remote is painted on. The first is the LIGHTEST panel
 *  the live retest measured behind the Matrix routes, so it is the binding one. */
export const DARK_PANELS: ReadonlyArray<readonly [string, readonly [number, number, number]]> = [
  ['shell panel, lightest measured rgb(43,49,55)', [43, 49, 55]],
  ['--hug-bg-1 #12121e', [18, 18, 30]],
  ['--hug-bg-0 #0a0a12', [10, 10, 18]],
];

type Rgba = [number, number, number, number];

function parseColor(css: string): Rgba {
  const m = css.match(/rgba?\(([^)]+)\)/);
  if (!m) {
    throw new Error(`dark-panel-contrast: cannot parse colour "${css}"`);
  }
  const parts = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
  return [parts[0], parts[1], parts[2], parts.length > 3 ? parts[3] : 1];
}

function over(top: Rgba, under: readonly [number, number, number]): [number, number, number] {
  const a = top[3];
  return [0, 1, 2].map((i) => top[i] * a + under[i] * (1 - a)) as [number, number, number];
}

function luminance([r, g, b]: readonly [number, number, number]): number {
  const f = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

export function contrastRatio(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** The worst (lowest) ratio of `el`'s text over the dark panels, with every
 *  background fill between `el` and `root` (inclusive) composited on top. */
export function worstDarkPanelContrast(el: Element, root: Element): { ratio: number; panel: string; color: string } {
  const fills: Rgba[] = [];
  for (let n: Element | null = el; n; n = n.parentElement) {
    fills.push(parseColor(getComputedStyle(n).backgroundColor));
    if (n === root) {
      break;
    }
  }
  const color = getComputedStyle(el).color;
  const fg = parseColor(color);
  let worst = { ratio: Infinity, panel: '', color };
  for (const [name, panel] of DARK_PANELS) {
    let bg: [number, number, number] = [panel[0], panel[1], panel[2]];
    for (let i = fills.length - 1; i >= 0; i--) {
      bg = over(fills[i], bg);
    }
    const ratio = contrastRatio(over(fg, bg), bg);
    if (ratio < worst.ratio) {
      worst = { ratio, panel: name, color };
    }
  }
  return worst;
}

/** Assert every element matching `selector` under `root` exists and reads at
 *  >= `min`:1 (WCAG AA body text) on every dark panel. Returns how many matched. */
export function expectReadableOnDarkPanels(root: HTMLElement, selector: string, min = 4.5): number {
  const els = Array.from(root.querySelectorAll(selector));
  expect(els.length).withContext(`"${selector}" rendered`).toBeGreaterThan(0);
  for (const el of els) {
    const w = worstDarkPanelContrast(el, root);
    expect(Math.round(w.ratio * 100) / 100)
      .withContext(`"${selector}" (${(el.textContent ?? '').trim().slice(0, 40)}) colour ${w.color} on ${w.panel}`)
      .toBeGreaterThanOrEqual(min);
  }
  return els.length;
}
