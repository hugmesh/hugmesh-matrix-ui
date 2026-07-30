// Accessibility step definitions. Cluster-free assertions over the rendered
// a11y contract the Matrix components ship: the skip-to-main-content link
// (app.component.html `a.sr-skip` → `#main-content`), the labelled moderation
// heading (`#mod-panel-h`), and (for the disclosure pattern) Escape-closes +
// focus-restore on the role-actions trigger.

import { expect } from '@playwright/test';
import { Then } from '../support/fixtures';

Then('the page exposes a skip-to-main-content link', async ({ page }) => {
  // The standalone shell renders `<a class="sr-skip" href="#main-content">`.
  // When the Matrix remote is federated into the host the host provides the
  // skip link instead, so we accept either the shell's sr-skip anchor OR any
  // in-page anchor targeting #main-content.
  const skip = page.locator('a.sr-skip, a[href="#main-content"]');
  await expect(skip.first()).toHaveAttribute('href', '#main-content');
});

Then('the moderation panel has an accessible heading', async ({ page }) => {
  // moderation-panel.component.html: <section aria-labelledby="mod-panel-h">
  // with <h2 id="mod-panel-h">Moderation & safety</h2>.
  const panel = page.getByTestId('moderation-panel');
  await expect(panel).toHaveAttribute('aria-labelledby', 'mod-panel-h');
  await expect(page.locator('#mod-panel-h')).toHaveText(/moderation/i);
});
