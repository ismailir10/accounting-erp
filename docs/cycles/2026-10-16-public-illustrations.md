# Public page: drawn illustrations instead of app screenshots

**Roadmap:** supports Phase 0 (ready for an outside firm): the page a prospective firm reads first.

## Context
The signed-out `/` explained source → journal → close → reports with saved app screenshots (`public/product/*.webp`).
- The crops were cramped: a squeezed close panel, and source and journal sheets cut mid-table.
- The trial-balance preview rendered as an empty white box at desktop width.
- Screenshots read as "here is our admin screen" rather than a story.

The owner asked for illustrations instead of screenshots, built with React Bits components ("dont use bullshit screenshot like
that … make us proud").

## Decisions
- **One illustration system** in the hero's paper-and-ledger style: hairline sheets with an offset sheet behind (depth without
  shadows), a slight tilt from `md` up (straight on phones for legibility), the one blue for the trace, and status colours only
  for status.
- **Three drawings** replace the six screenshot slots (`components/app/public-illustrations.tsx`):
  1. **Rekening koran → Jurnal.** Continuous-form statement paper with tractor-feed holes. Row 11 is highlighted with its real
     date and raw description. A line draws to a balanced journal: the three real lines, the totals, and the source chip
     (file · row), then *Debit = kredit* checks in.
  2. **Tutup Buku checklist.** The counts 9 *Perlu dicek* and 12 *Lolos* count up. Problems come first, passes fold, and the lock
     stays open: "Kunci bulan setelah temuan selesai".
  3. **Report stack.** Neraca and Laba Rugi peek behind the Neraca Saldo. The 4100 Penjualan line traces to
     `BCA-5566-2026-08.csv · baris 11`. The totals count up to Rp 12.552.852.217 = Rp 12.552.852.217, with Excel and PDF chips.
- **Honest data.**
  - Every figure, name and row number comes from `public/product/capture-manifest.json`, which the real app produced and the
    capture script asserts through the UI.
  - Where the demo has no number (neighbouring statement rows, per-account balances), the drawing shows a neutral bar, never an
    invented amount.
  - Each figure keeps the synthetic-data label.
- **React Bits, within ui-rules** (ported without a motion dependency, like the existing pieces):
  - `Reveal`, from AnimatedContent + AnimatedList: settles in once and staggers list children.
  - `CountUpOnView`: counts when scrolled into view, in full Rupiah.
  - `.trace-draw`: the source-to-result line draws once.
  - `CheckDraw`: now held until its section is shown.
  - All of it is ≤ 450 ms per step, plays once, and is never inside the app.
  - Content on screen at mount, no-JS, print and `prefers-reduced-motion` always show the final state. Only content the reader
    hasn't seen yet is hidden, so nothing visible flashes.
  - ui-rules lists these as public-site-only pieces.
- **Screenshots removed.**
  - The 14 WebP files and the manifest's `assets` are gone, along with the `next.config.ts` image patterns built from them.
  - `scripts/capture-public-demo.ts` still logs in to the local demo and asserts every figure and view on desktop and phone, but
    saves no images.
- **Steps strip:** icon tiles plus "Langkah n". The copy is otherwise unchanged except two sentences that now match the drawings.

## Acceptance criteria
- [x] No `<img>` on `/`; the source, firm and company sections each carry a labelled drawing built from manifest facts (unit test).
- [x] Desktop (1280) and phone (390, 375): no horizontal scroll, no truncated account or entity names, arrows don't overlap labels.
- [x] Reduced motion: nothing ever hidden. Normal: only below-the-fold drawings start hidden, and all are shown after scrolling.
      Totals count through real frames and end exact (browser check).
- [x] No screenshot files remain in `public/product`; README and ui-rules describe the new approach.

## Non-goals
Hero redesign (it already is an illustration), copy rewrite, deck changes (the decks don't use these screenshots), new dependencies.

## Tasks
- [x] T1 Motion ports, illustrations, landing, screenshot removal, tests, docs.

## Verification
- **Task gate:** `npm run lint` and `npm run typecheck` exit 0. `npm test`: 279 files, 2,609 tests passed. `npm run build`:
  compiled successfully.
- `tests/unit/public-product.test.ts` (new):
  - each section's drawing carries the manifest facts: row 11 with its raw description, the three journal lines and amounts,
    *Debit = kredit*, the 9 and 12 control counts, the four problem titles, and the Rp 12.552.852.217 total traced to
    `BCA-5566-2026-08.csv · baris 11`;
  - no `<img>` on the page;
  - no screenshot files and no manifest `assets`.
- **Browser, dev server.** Desktop 1280 and phones 390 and 375: horizontal overflow 0. The phone round fixed three issues
  (truncated account names, an arrow overlapping its label, a truncated entity name), all re-shot clean.
- **Motion.**
  - Reduced motion: 0 hidden at load, all static, the total final from the first paint.
  - Normal: 3 hidden at load (below the fold) and 0 after scrolling. The total ran through 7 distinct frames and ended at exactly
    Rp 12.552.852.217; the counts end at 9 and 12.
- **Production server** (`next start`, 390 px): 3 hidden at load, 0 after scrolling, 0 images, overflow 0, no console errors.
- **Not run locally:** `e2e/public-site.spec.ts` needs the local Auth stack (Docker is not running in this sandbox). It is updated
  to the new page and the PR carries the `e2e` label so CI runs it.
