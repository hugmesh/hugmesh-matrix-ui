/**
 * Shared SPEC helpers asserting the HugMesh HELP-TEXT a11y contract:
 *
 *  1. every interactive control that carries `aria-describedby` points at an
 *     element that ACTUALLY EXISTS in the same DOM (a dangling describedby is
 *     announced as nothing — worse than no help), and
 *  2. that target carries real, non-blank help copy.
 *
 * Used by the component specs so the "help is programmatically associated +
 * present" invariant is enforced in CI, not just authored once.
 */

/** Assert that `selector`'s element has an aria-describedby pointing at a
 *  present, non-blank help element. Returns the resolved help text. */
export function expectDescribedByHelp(root: HTMLElement, selector: string): string {
  const control = root.querySelector(selector);
  if (!control) {
    throw new Error(`expectDescribedByHelp: no control matched "${selector}"`);
  }
  const ids = (control.getAttribute('aria-describedby') ?? '').trim();
  expect(ids).withContext(`${selector} aria-describedby`).not.toBe('');
  let text = '';
  for (const id of ids.split(/\s+/).filter(Boolean)) {
    const target = root.querySelector(`#${CSS.escape(id)}`);
    expect(target).withContext(`${selector} describedby target #${id} exists`).toBeTruthy();
    text += ' ' + (target?.textContent ?? '');
  }
  expect(text.trim().length).withContext(`${selector} help text non-blank`).toBeGreaterThan(0);
  return text.trim();
}

/** Assert that `selector`'s element has a non-blank ACCESSIBLE NAME — either an
 *  aria-label, an aria-labelledby that resolves, or visible text content. */
export function expectAccessibleName(root: HTMLElement, selector: string): string {
  const el = root.querySelector(selector);
  if (!el) {
    throw new Error(`expectAccessibleName: no element matched "${selector}"`);
  }
  const label = (el.getAttribute('aria-label') ?? '').trim();
  if (label) return label;

  const labelledby = (el.getAttribute('aria-labelledby') ?? '').trim();
  if (labelledby) {
    let text = '';
    for (const id of labelledby.split(/\s+/).filter(Boolean)) {
      text += ' ' + (root.querySelector(`#${CSS.escape(id)}`)?.textContent ?? '');
    }
    if (text.trim()) return text.trim();
  }

  const visible = (el.textContent ?? '').trim();
  expect(visible.length).withContext(`${selector} accessible name`).toBeGreaterThan(0);
  return visible;
}
