# ZenithCore FMIS – Accessibility

Target: **WCAG 2.1 level AA** in Arabic (right-to-left), English and French.

## Done

- Every screen starts with a *Skip to main content* link, first in the tab order.
- Visible focus indicator on every interactive element (`:focus-visible`).
- Every form control has an accessible name (a label or `aria-label`).
- `lang` and `dir` are set on the page for the chosen language; Arabic is fully right-to-left.
- Messages and errors are announced to screen readers (`role="status"` / `role="alert"`).
- Table rows that open a record work with the keyboard (Tab, then Enter).
- Motion is reduced when the user asks for it (`prefers-reduced-motion`).
- Receipts print cleanly without the navigation.
- Status is never shown by colour alone: every chip carries text.

The browser rehearsal `scripts/e2e-d4d5.mjs` checks the skip link, `lang`/`dir`, and that no form control lacks a name on every screen it visits, and fails if any check fails.

## Still to do before the demonstration

- A full automated audit with axe-core (it could not be installed in the build environment).
- Manual testing with a screen reader in Arabic (NVDA) and English, and with 200% zoom.
- Measuring colour contrast of the theme against AA (4.5:1 for text).
