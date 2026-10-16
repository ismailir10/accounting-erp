---
name: ui-rules
description: Buku UI standard — Ramp-style look (warm grey canvas, near-black ink, one strong blue, soft 8–16px corners, large regular-weight sans headlines), shadcn-first, "Don't Make Me Think" rules and Bahasa copy. Load before touching app/ or components/.
---

# UI rules

## Look — Ramp-style, strong blue (tokens in `app/globals.css`; never hard-code hex in components · [ADR 0016](../../../docs/adrs/0016-ramp-restyle.md))
- Warm grey canvas `--background #F4F2F0`; **white is for working surfaces** (cards holding tables and forms, fields) and the sidebar is white.
  1px warm hairline `--border #E4E0DB`, near-black ink `--foreground #0C0A08`, secondary text `--muted-foreground #5F5B58`.
- **One strong blue `--primary #2152E8`** (6.1:1 on white, 5.5:1 on the canvas): actions, focus rings, selected states. `--brand` is the same
  blue as a fill with white text: the primary button, the logo, the `NextStep` marker. **Blue is for things you can do, never for a figure.**
  Where Ramp uses lime, Buku uses this blue; nothing else is a second accent. No green in the chrome.
- Sidebar: active item = pale-blue tint (`sidebar-primary`) with dark-blue text, hover = warm grey; text uses `sidebar-*` tokens.
- Status tokens `pass / review / fail` (+ `-subtle`) are reserved for control & state — never chart series.
- Soft corners: `--radius` 8px (controls), cards and panels 12px (`rounded-xl`), auth card 16px, chips and pills fully round. Cards are
  hairline-bordered, flat: no shadow, no gradient. Controls are 36px high (sm 32, xs 28, lg 40).
- **`NextStep` is a pale-blue panel** (`primary-subtle`, no border) with a round blue marker; the done state is the green check on `pass-subtle`.
- **Icon tile** (`.icon-tile`): pale-blue rounded square with a blue glyph or step number, to lead a card or list row.
- **Buttons:** the blue primary; `outline` (white, hairline) and `ghost` for the rest; `ink` (near-black) exists for a rare second emphasis and
  never sits next to the blue primary in the same row.
- **Drill-down = `.drill`**: a figure or account name you can open is ink with a dotted underline at rest (visible without hover), solid blue
  on hover/focus. Never a blue underlined number; never hand-copy underline classes.
- **Status is icon + label in the status colour, no fill** (`StatusPill`); only a failure keeps a subtle fill (as a round chip). Don't box every cell.
- **No boxes in boxes.** A card holding a list shows divided rows, not a bordered card per row. Same page, same fact: shown once.
- Chart series colours are their own tokens (`--chart-1…5`, validated with the `dataviz` validator); `--chart-1` is the brand blue.
- Type: **Hanken Grotesk** (self-hosted variable, `@fontsource-variable/hanken-grotesk`) for everything. Ramp's own face (Lausanne) is
  commercial, so this is the closest free neighbour with tabular numerals. **`.display`** (regular 450 weight, −0.025em tracking, 1.1 line
  height) for page titles, the login heading and `Stat` values; no serif anywhere. `.num` = tabular numerals on every amount.
  **Micro-labels** (table headers, sidebar group labels, stat labels, eyebrows) use `.eyebrow`: the UI sans, 12px, medium, sentence case,
  muted. Never monospace or uppercase-tracked (it reads as generic AI chrome). Monospace stays only for file names, patterns and raw bank text.

## Components
- **shadcn first** (`components/ui/*`, base-nova on `@base-ui/react` — composition uses `render={<Link/>}`, not `asChild`).
  Vendored from annisaa-erp-v3 because `ui.shadcn.com` is blocked in the sandbox; add new ones from npm `shadcn` registry source or copy, then adapt tokens.
- Product building blocks in `components/app/`: `PageHeader`, `NextStep`, `Stat`, `Money`, `StatusPill`, `MethodBadge`, `ScopeBar`, `FsTable`, charts. Reuse before creating.
  Motion pieces live in `components/motion/` (see §Motion).
- Charts: shadcn `chart` + Recharts. Load the `dataviz` skill first; run its palette validator. Single series → no legend;
  ≥2 series → legend + tooltip; if a colour fails 3:1 contrast, show the numbers in a table too. `isAnimationActive={false}`.
- **Checkbox gotcha:** never wrap a base-ui `Checkbox` in `<label>` — the click is forwarded and toggles twice.
  Use `id` + `<label htmlFor>`.
- Don't block keyboard input on `useTransition` pending when a `router.refresh()` follows; use an explicit busy flag.

## Motion (`components/motion/`, ported from React Bits without a motion dependency)
Motion is information, not decoration: it says *you arrived*, *this changed* or *this is done*. Otherwise nothing moves.
- **Approved pieces:** `.page-settle` (every page via `app/(app)/template.tsx`, the auth card), `CountUp` (stat tiles, counts),
  `ProgressFill`, `CheckDraw` (the done mark in `NextStep`), `DotGrid` (auth pages only). Reuse them; don't add a second way to do the same.
- **Public site only** (`components/app/public-*`): `Reveal` (React Bits AnimatedContent + AnimatedList: settles in once on first scroll into
  view, `data-stagger` children follow by `--i`), `CountUpOnView` (counts when scrolled into view, full Rupiah), `.trace-draw` (a source →
  result line draws once). Content already on screen, no-JS, print and reduced motion always show the final state. Never inside the app.
- **Public illustrations, not screenshots.** The public page draws the product (`components/app/public-illustrations.tsx`) from the verified
  demo manifest (`public/product/capture-manifest.json`); a neutral bar stands in for any number the demo doesn't have. No app screenshots.
- **Limits:** ≤ 450 ms, plays once, ease-out. Never on report/ledger tables, rows, inputs or anything the user is typing into; never loops.
- `prefers-reduced-motion` → no motion at all (the CSS and `useArrival` handle it; new motion must too).
- Hydrated server HTML never replays (`useArrival`): the value painted first is the value kept. Only client navigation animates.
- Money moves in bigint (`lib/motion.ts` `tweenMinor`) and every frame is a real formatted amount; the last frame is the value exactly.
- No lasting `transform` on page wrappers (fixed children would anchor to it) — animate `translate` with fill-mode `backwards`.
- **Stays out** (breaks the look or the "No AI-slop" list): React Bits backgrounds other than DotGrid (aurora, plasma, silk, beams, particles…),
  gradient/shiny/glitch/decrypt/scramble text, glass, glow/star borders, spotlight/tilt/magnet cards, cursor effects, 3D, click sparks.

## "Don't make me think"
1. **Every page says what to do next** — a `NextStep` banner: **one** plain sentence (the instruction itself, no
   "Langkah berikutnya:" prefix, no icon except the check on completed states) and at most one CTA. Key-binding and how-to hints
   go in a hint row, not in the banner. A list under the banner starts *after* the job the banner names.
2. One primary button per view; everything else `outline`/`ghost`.
3. State lives in the URL (`?period=2026-08&entity=<id>|combined`) so every view is linkable; pickers via `ScopeBar`.
4. Numbers right-aligned, accounting parentheses for negatives, `–` for zero.
5. **Every report number is clickable down to its source** (FS line → account → ledger → bank row sheet).
6. Status = icon + label + colour, never colour alone (`StatusPill`).
7. Errors say what happened and what to do, in Bahasa (server actions return `{ok:false, error}` — show verbatim).
8. Layout works at 390px: no horizontal page scroll. Hide secondary table columns on phones
   (`hidden md:table-cell`); report comparison columns hide below `sm` (`FsTable`).
9. Show each fact once. Don't repeat a value in a badge *and* a field (e.g. suggested account lives only in the select).
10. Problems first: sort FAIL → REVIEW → PASS inside lists; summarise blockers as counts, the detail is already on screen.
    **Passed items fold** into a "N … lolos" disclosure (still in the DOM); never give them the same weight as the problems.
    Text that explains a problem **wraps in full** — no `line-clamp` on a sentence the accountant has to act on.
11. No hidden affordances — nothing that only appears on hover. Rows link via their name + a visible chevron.
12. A card that only says "X isn't set up" doesn't render (AI review without a key). Empty states say what's true ("Tidak ada transaksi pajak terdeteksi bulan ini"), never a column of dashes.
13. Companies before individuals (PT/CV, then the owner) everywhere entities are listed.
13a. A page that holds unrelated groups of settings splits into sections with `LinkTabs` (`?tab=`, server-rendered, one section on screen, an unknown
    tab falls back to the first). Name the page for what it holds ("Pengaturan klien"), not for its last section.
14. **One first-run order, computed once:** Unggah data → Saldo awal → Review → Tutup buku (`lib/setup-progress.ts`). Every page that says
    what to do next reads it — never a hand-rolled if/else chain. Setup pages (client Ringkasan, Impor, Saldo Awal) show `SetupSteps`
    ("Langkah n dari 4"); the client menu lists the steps in that order and never hides them in a collapsed group.

## No AI-slop
- No sparkles/magic-wand icons, no gradients-as-decoration, no glassmorphism, no emoji in UI.
- No hype copy ("makin pintar", "ajaib", "powered by AI"). Label what it is: "Dikode otomatis", "Usulan AI".
- AI is shown as a small `AI` method badge + a reason + a confidence; low confidence (<70%) is called out in review colour.
- Hints must be true in both directions ("Naik/Turun …"), never a hard-coded "Naik".

## Copy (Bahasa)
- Accountant vocabulary, not developer vocabulary: *Buku Besar, Neraca Saldo, Laba Rugi, Neraca, Tutup Buku,
  Jurnal Penyesuaian, Rekening Koran, Mutasi, Saldo Awal, Prive, Gabungan Grup*.
- Status words: *Lolos / Perlu dicek / Gagal*, *Nyambung / Ada celah*, *Buku ditutup*.
- Sentence case; short; no exclamation marks; name the thing (“Tutup buku Agustus 2026”, not “Lanjut”).
