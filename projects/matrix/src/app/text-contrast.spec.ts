import { ComposerComponent } from './composer.component';
import { TimelineComponent } from './timeline.component';

/**
 * Secondary text in the chat panel must reach WCAG 1.4.3 (4.5:1) on the dark
 * panel (--hug-bg-1, #12121e). `.reply-quote` was #666 (3.23:1) and the
 * composer's help/status/off-state text was $muted #777 (4.15:1).
 *
 * Reads the styles Angular actually compiled for each component, takes the
 * colour each rule paints (a var()'s literal fallback, which is what renders
 * when the token is missing), and measures it against the panel.
 */

type RGB = [number, number, number];

function luminance([r, g, b]: RGB): number {
  const chan = (v: number): number => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b);
}

function contrast(a: RGB, b: RGB): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function hex(h: string): RGB {
  const x = h.replace('#', '');
  const f = x.length === 3 ? x.split('').map((c) => c + c).join('') : x;
  return [parseInt(f.slice(0, 2), 16), parseInt(f.slice(2, 4), 16), parseInt(f.slice(4, 6), 16)];
}

/** Every `color:` painted by rules whose selector mentions `cls`. */
function colorsFor(component: unknown, cls: string): string[] {
  const css = ((component as { ɵcmp: { styles: string[] } }).ɵcmp.styles || []).join('\n');
  const out: string[] = [];
  const rule = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = rule.exec(css))) {
    if (!m[1].includes(cls)) continue;
    const decl = /(?:^|;)\s*color\s*:\s*([^;]+)/g;
    let d: RegExpExecArray | null;
    while ((d = decl.exec(m[2]))) {
      const literal = d[1].match(/#[0-9a-fA-F]{3,6}\b/g);
      if (literal) out.push(literal[literal.length - 1]);
    }
  }
  return out;
}

const PANEL = hex('#12121e');

describe('chat secondary text contrast (WCAG 1.4.3)', () => {
  for (const [name, component, cls] of [
    ['timeline .reply-quote', TimelineComponent, '.reply-quote'],
    ['composer .field-help', ComposerComponent, '.field-help'],
    ['composer .status', ComposerComponent, '.status'],
    ['composer .is-off', ComposerComponent, '.is-off'],
  ] as const) {
    it(`${name} paints >= 4.5:1 on the dark panel`, () => {
      const colors = colorsFor(component, cls);
      expect(colors.length).withContext(`no color rule found for ${cls}`).toBeGreaterThan(0);
      for (const c of colors) {
        expect(contrast(hex(c), PANEL)).withContext(`${name} ${c}`).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
});
