# Legal pages: complete drafts of Syarat and Kebijakan privasi

**Roadmap:** Phase 0, item 3 (`docs/roadmap.md`, ADR 0020). The agent drafts the text; the owner signs off.

## Context
`/syarat` and `/kebijakan-privasi` already describe the product's real behaviour precisely: trial requests, expiry, support
sessions, retention, and the AI payload of each task. They lacked the parts a firm's partner or lawyer looks for before a trial:
- who operates the service, and who is the data controller and who the processor (UU PDP);
- fees;
- data ownership;
- liability;
- how use ends;
- who receives data;
- cookies;
- breach notification;
- governing law and disputes.

## Decisions
- **Operator.** Buku is operated by Right Jet (right-jet.com), the brand already used in the decks. The legal entity name,
  address and chosen court are not in the repo, so the draft banner names exactly these three for the owner to confirm.
- **Controller and processor.** Right Jet is the controller for trial requests and member accounts. For bookkeeping content the
  organisation is the controller and Buku the processor. This also decides who notifies whom after a breach.
- **Breach notice.** Written notice within 3 x 24 hours, per UU PDP Art. 46:
  - to data subjects and the authority, for the data Right Jet controls;
  - to the organisation, for its bookkeeping content, so it can meet its own duty.
- **Cookies.** Stated as verified in code: login session cookies, the support-session cookie (`buku_support`), and browser
  storage for display preferences. There is no analytics, advertising or third-party tracking in `app/layout.tsx` or
  `package.json`.
- **Recipients** are named by category (hosting and database, the login and email service, the AI provider when enabled).
  The existing test forbids vendor names on these pages.
- **Security claims** are limited to what the code does:
  - encrypted connections;
  - role and client-assignment access;
  - an append-only change log;
  - encrypted AI key (`SETTINGS_SECRET`) and PDF passwords (ADR 0018);
  - 2FA-gated, logged support sessions.
  Nothing is claimed about provider certifications.
- **Commercial terms:**
  - the trial is free unless agreed in writing, and nothing is charged automatically;
  - paid use needs a separate agreement;
  - data stays the organisation's, is never sold or used for ads, and can be exported as Excel/PDF while access lasts;
  - the software stays Right Jet's.
- **Liability:** the trial is provided as is. Indirect loss is excluded as far as the law allows, and statutory rights,
  including UU PDP rights, are untouched.
- **Law:** Indonesian law and the Bahasa text govern. Disputes go to musyawarah for 30 days, then Pengadilan Negeri Jakarta
  Selatan. The court is a draft choice for the owner to confirm.
- **Contents:** both pages get a contents list (`nav` "Isi halaman"). It is sticky beside the text on desktop and sits above
  the text on a phone.

## Acceptance criteria
- [x] Both pages name the operator and the controller/processor split; Terms add fees, ownership, liability, ending and law;
      Privacy adds recipients, cookies and breach notice. Existing behaviour sections are unchanged.
- [x] Every statement about the product matches the code; no vendor names (existing test).
- [x] The contents list links every section in order (test).
- [x] Desktop (1280) and phone (390) render without horizontal scroll.

## Non-goals
Signing off the text (owner); collecting consent or adding a cookie banner (only necessary cookies exist); changing any data
handling.

## Tasks
- [x] T1 Content, contents navigation, tests, screenshots.

## Verification
- `tests/unit/public-legal.test.ts`: 12 tests pass. The new tests cover the operator section, the contents order, the Terms
  commercial and dispute terms, and the Privacy recipients, cookies and breach notice.
- Dev server, `/kebijakan-privasi` and `/syarat` at 1280 and 390 px: horizontal overflow 0 px on both.
