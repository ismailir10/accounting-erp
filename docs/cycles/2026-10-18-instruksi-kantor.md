# Instruksi kantor: firm instructions compiled into rules and controls

**Roadmap:** Phase 2 item 5. `docs/roadmap.md` §5, Phase 2, item 5: "What the accountant writes: a plain-Bahasa instruction, for example
'biaya admin bank selalu 6190' or 'tandai pengeluaran > Rp10 jt'. What Buku does with it: compiles it into a deterministic rule or
control. The accountant previews it and approves it. Fixed rule: the instruction is never a free-text prompt at run time."
[ADR 0020](../adrs/0020-roadmap-after-the-spine.md) §2: "'Instruksi kantor' becomes deterministic rules the accountant approves; it is
never a prompt at run time." The [Otomasi](2026-10-17-otomasi.md) and [Checklist tutup buku](2026-10-17-checklist-tutup-buku.md)
cycles left this item out of scope.

**Approval:** the owner approved building [Instruksi kantor](2026-10-18-instruksi-kantor.md), [Usulan akrual](2026-10-18-usulan-akrual.md) and [Persetujuan kedua](2026-10-18-persetujuan-kedua.md) on 2026-10-17 ("Build all three"). Open questions settled: an assigned Akuntan may approve an instruction for one client (books.write on it); firm-wide ones need Pemilik/Admin; the keyword hints and *Tahan di Review* stay in v1, as recommended.

## Context
How a firm tells Buku "always do X" today, read from the code:
- **Rules exist, but only two ways in.**
  - The firm's starter rules are seeded once per firm (`FIRM_RULES`, priority 10–50, source `SEED`), e.g. BIAYA ADM → 7100.
  - A client rule is made only from Review's *Selalu gunakan akun ini*: the line's merchant key becomes the pattern, priority 60, source
    `USER`. A merchant key that names no counterparty (`isGenericKey`) is refused ("… tidak bisa dijadikan aturan").
  - There is no screen to write a firm rule, a rule with a chosen keyword, or a rule for one direction. Pengaturan klien → *Klasifikasi & AI*
    lists client and firm rules read-only.
- **How a rule decides.** A rule is a case-insensitive substring of the bank description, an optional direction, an account and a tax tag.
  Client rules rank before firm rules, then lower priority, then the longer pattern; a firm rule whose pattern strictly contains a matching
  client rule's wins (rule 13). A rule whose account the client's chart lacks is skipped. A rule match is RULE at 0.97 and posts directly
  unless the firm's Otomasi dial holds it (rule 14).
- **No configurable control exists.** Every close control is code (`runControls`, sanity, anomaly). REVIEW needs a note; a note clears it
  only while the control's detail is unchanged. The one firm setting that touches controls is *Ambang fluktuasi*. The sign-off *Bukti
  pendukung transaksi besar sudah diperiksa* is a manual tick with no amount behind it.
- **No way to say "always look at this one".** The dial holds by source or by a firm-wide cap; nothing holds one counterparty.
- **AI paths.** Every paid call goes through `runBudgetedAi` (reserve, settle, `AiUsage`), is cached (`EvidenceAiCache`, a hash of input,
  model and prompt version), has a `MockProvider` answer for tests and never retries. Account mapping sends names only (rule 17).
- **Riwayat perubahan** is per client and append-only; a firm setting writes one event per client (*Otomasi kantor*).

Who feels it:
- **The partner** who says "biaya admin bank selalu 6190" to every new junior, and has no way to make Buku say it instead.
- **The accountant** who checks every payment above Rp 10 jt by habit, with nothing on Tutup Buku that lists them.
- **The pilot's exit test:** fewer review minutes per client-month needs the firm's own habits to run as rules, not as reminders.

Digits' "Agentic Close" is the pattern: the firm writes instructions in plain words, the product compiles them into deterministic,
always-on checks, and only exceptions reach a person. Buku's rule 4 adds: a person approves the compiled form before it runs.

## Decisions
- **An instruction compiles to exactly one of three things (v1).**

  | Kind (UI label) | What the accountant writes | What it becomes | Where it acts |
  |---|---|---|---|
  | **Aturan akun** | "biaya admin bank selalu 6190", `"BIAYA ADM" keluar → 6190`, "uang masuk dari TOKOPEDIA ke 4100" | an ordinary `Rule`: keyword, direction or both, account, tax tag or none | the next imports' classification (rule 13) |
  | **Tandai** | "tandai pengeluaran > Rp10 jt", "cek penerimaan TOKOPEDIA di atas 50 jt" | a REVIEW close control: direction, a minimum amount, optional keyword | Tutup Buku of every open month |
  | **Tahan di Review** | "PT MAJU JAYA selalu ke Review", "tahan pembayaran ke PT MAJU JAYA" | a hold: keyword, direction or both, optional minimum amount | the next imports' post-or-hold decision (rule 14) |

- **Nothing runs on free text.** The typed sentence is stored for display and Riwayat only. Import and controls read the compiled fields
  (`Rule` rows and the instruction's typed columns). The AI compile step is called only from the editor, on the accountant's click, never
  from an import, a control, a preview or a background run.
- **Buku's own parser first.** A deterministic reader for the shapes in the table above:
  - **Keyword.** Text in quotes wins. Otherwise the words before the verb (*selalu*, *ke*, *masuk ke*, *→*, *=*), with a leading direction
    phrase removed (*uang masuk dari*, *pembayaran ke*, *pengeluaran*). Stored in capitals, 3–60 characters.
  - **Direction.** *penerimaan, uang masuk, masuk, setoran, terima* = money in. *pengeluaran, uang keluar, keluar, pembayaran, bayar* =
    money out. With none written, an *Aturan akun* takes it from the target account (a BEBAN account = out, a PENDAPATAN account = in,
    anything else = both), and the preview says so ("Arah: uang keluar, karena 6190 akun beban").
  - **Account.** A code from the chart, or an account name that matches exactly one account. Optionally a tax tag by its label (*PPN
    Masukan*, *PPh 23* …).
  - **Amount.** *Rp10 jt*, *10 juta*, *Rp 10.000.000*, *500 rb*, *1,5 M* / *miliar*, read in bigint whole Rupiah (no floats; a fraction
    of a Rupiah is refused). *>*, *lebih dari*, *di atas* = strictly above; *≥*, *minimal*, *paling sedikit*, *mulai Rp* = at least.
- **AI only when the parser can't, and only on a click.**
  - When the parser says "not recognised" (not one of the explicit refusals below) and the workspace has a key and model, the editor offers
    *Susun dengan AI*. Without a key it shows the patterns that work.
  - **Payload:** the sentence (≤ 300 characters) and the account list it may target (code and name, the same whitelist as below; 1190/1199
    removed as `aiAccounts` does). No bank lines, amounts from the books, client names or descriptions.
  - **Closed schema:** one JSON object `{kind: ACCOUNT|FLAG|HOLD|NONE, pattern, direction, accountCode, taxTag, minAmount, inclusive}`.
    Any other key, a second object or a NONE ends it ("AI juga tidak dapat menyusun instruksi ini. Tulis dengan salah satu pola di
    bawah.").
  - **Grounded or dropped:** the pattern must appear in the sentence (case and spaces ignored), the amount must be one Buku's own reader
    finds in the sentence, the account must be in the whitelist. Then the same validation as the parser's output.
  - **Money:** one budgeted call (`runBudgetedAi`, scope `instruksi:<firm>`), cached by sentence, account list, model and prompt version,
    no retry, `MockProvider` in tests.
  - The result is a draft like the parser's, marked *Disusun AI*. Only a person's *Setujui* stores it (invariant 4).
- **The preview is the approval screen.** Nothing is stored until *Setujui*: compiling and previewing are reads.
  - **The structured form as one sentence:** "Mutasi keluar yang keterangannya memuat "BIAYA ADM" → 6190 Beban Umum Lain-lain, sebelum
    aturan kantor lain."
  - **Every field is editable** (keyword, direction, account, tax tag, amount and operator), as Kotak's *Ubah*. *Setujui* is enabled only
    for the preview of the fields as shown.
  - **The lines it would have matched.** Per client in scope, its last three months that have bank lines: a count per month, the total,
    and up to 20 lines (date, client, description, amount, current account and method). The matcher is the run-time one:
    - *Aturan akun*: the line counts when the new rule wins `matchRule` against the client's current rules. Lines the transfer matcher
      decided (method TRANSFER) are counted apart as "tidak terpengaruh, transfer". It also shows "M baris sekarang di akun lain (7100,
      aturan kantor BIAYA ADM)", and clients whose chart lacks the account ("dilewati di 2 klien: …").
    - *Tahan di Review*: matched lines, and of them how many posted directly and would now wait.
    - *Tandai*: per month, the lines the control would list.
  - **Keyword hints.** When the keyword as typed matches nothing, Buku offers up to three keywords where the bank abbreviates its words
    (each word of the hint a prefix of at least 3 letters of the typed words, in order: *BIAYA ADM* for "biaya admin bank"). They come
    from the scope's rule patterns and merchant keys and are ranked by lines matched. One click uses a hint. The roadmap's own example
    needs it: the demo prints "BIAYA ADM", never "BIAYA ADMIN BANK".
  - **Footer:** "Menyetujui tidak mengubah mutasi yang sudah dicatat. Aturan dan tahan berlaku untuk impor berikutnya; tandai berlaku
    untuk bulan yang belum dikunci."
- **What approval makes.**
  - **Aturan akun** → one `Rule` with `source` INSTRUKSI, `instructionId` set, priority 5 (before every seeded firm rule). It is a firm
    rule for *Semua klien*, a client rule for one client. Client-before-firm and the specificity exception are unchanged (rule 13). A
    matched line's reason reads `Instruksi kantor: keterangan memuat "BIAYA ADM"`. It is RULE 0.97, so the dial's *Aturan* switch and
    *Batas nominal* apply as to any rule.
  - **Tandai** → one REVIEW control per entity, key `instr:<instruction>:<entity>`, in every month whose period is not locked:
    - **Lists:** the month's bank lines with that direction, absolute amount above (or at least) the minimum and, if given, the keyword.
    - **Title and detail.** The title is the compiled sentence ("Pengeluaran di atas Rp 10.000.000"). The detail lists up to five lines
      (date, description cut to 60 characters, amount) and "+N lainnya". With none, it is PASS ("Tidak ada pengeluaran di atas Rp
      10.000.000") and folds with the passed controls.
    - **Notes and the AI review.** A note clears it as any REVIEW control (stale when the list changes). The AI close review and
      *Jelaskan* may send its listed lines like any flagged control's rows (ADR 0009 rule 4, existing cap).
  - **Tahan di Review** → read by the import with the dial. A line the dial would post whose description holds the keyword (direction and
    minimum when given) waits in Review on 1999 instead:
    - its method, confidence and suggestion are kept, as for any held line;
    - its reason reads "Ditahan instruksi kantor "<sentence>". <classifier's reason>";
    - held transfers follow the dial's rules unchanged.

    The hold can only send more to Review. AI and the simple guess already wait. The import result counts it in "N ditahan Otomasi
    kantor (instruksi kantor)".
- **Refused, with the reason in Bahasa** (the parser refuses these outright; *Susun dengan AI* is not offered):
  - a journal, accrual or schedule (*catat jurnal, akrualkan, susutkan, amortisasi, setiap bulan*) → "Instruksi tidak membuat jurnal.
    Untuk jurnal berulang, pakai Jadwal di Jurnal Penyesuaian.";
  - a percentage or a movement (*naik, turun, %, fluktuasi*) → "Ambang fluktuasi diatur di Pengaturan kantor → Otomasi.";
  - a hold by amount only (*semua mutasi di atas Rp 50 jt ke Review*) → "Untuk menahan semua mutasi di atas nominal tertentu, isi Batas
    nominal di Otomasi. Instruksi tahan perlu kata kunci.";
  - a split (*bagi, 50/50, sebagian*) → "Pecah transaksi dilakukan per mutasi, di Review atau Buku Besar.";
  - AI behaviour or approval routing (*AI, minta persetujuan, partner harus*) → "Instruksi kantor tidak mengatur AI atau persetujuan.
    Usulan AI selalu menunggu persetujuan Anda.";
  - a date condition (*sebelum tanggal, mulai Januari, bulan Desember*) → "Syarat tanggal belum didukung. Instruksi berlaku sejak
    disetujui.";
  - more than one instruction (two targets, *dan … selalu*, several lines) → "Tulis satu instruksi per baris.";
  - a generic keyword (`isGenericKey`: *TRANSFER, BI FAST*) → "Kata kunci "TRANSFER" tidak menyebut pengirim atau penerima, jadi tidak
    bisa dijadikan aturan.";
  - an account no rule may target (not `isClassifiable`: banks, 1999, 3200, 3290; or 1190/1199) → "Akun 1999 tidak bisa menjadi tujuan
    aturan." / "Transfer antar rekening dipasangkan oleh Buku, bukan oleh aturan.";
  - an account no chart in scope has → "Akun 6195 tidak ada di bagan akun klien ini.";
  - the same active instruction again, or an *Aturan akun* on the same keyword, direction and scope as an active one with another
    account → "Sudah ada instruksi aktif untuk kata kunci ini: "…". Matikan dulu bila ingin menggantinya.";
  - anything else → "Buku belum memahami kalimat ini." with the three patterns as examples (and *Susun dengan AI* when available).
- **Lifecycle: Aktif → Dimatikan, no editing in place.**
  - *Matikan* deletes an *Aturan akun*'s `Rule` row in the same transaction. It removes a *Tandai* control from open months; its old notes
    stay, unused. It stops a *Tahan* for the next imports. The instruction row stays as *Dimatikan* for history.
  - To change one, turn it off and write a new one. No line already posted, held or noted is touched, on approval or on *Matikan*.
- **Who may.** No change to the permission matrix:
  - *Semua klien*: write, approve and turn off with `org.settings` (Pemilik, Admin).
  - One client: write, approve and turn off with `books.write` on that client (Pemilik, Admin, and an Akuntan assigned to it). This is the
    capability Review's *Selalu gunakan akun ini* already uses to make a client rule.
  - Refused while the organisation is read-only or in a support session, as every write is. An unassigned client reads as missing.
  - Peninjau, and an Akuntan for *Semua klien* instructions, see the list read-only. *Susun dengan AI* needs the same capability as
    approving, because it spends the firm's budget.
- **Every change is in Riwayat perubahan.** New kind `INSTRUCTION` ("Instruksi kantor"), written in the same transaction:
  - *Semua klien*: one event in every client of the firm; one client: one event there.
  - Before and after hold the sentence, kind, compiled fields (amounts as strings), scope and origin.
  - The summary reads, for example, `Disetujui: "biaya admin bank selalu 6190" → Aturan akun: keluar, memuat "BIAYA ADM" → 6190` or
    `Dimatikan: "tandai pengeluaran > Rp10 jt"`.
- **Origin is decided by the server, not the browser.** At *Setujui* the server parses the sentence again:
  - equal to the approved fields = *Disusun Buku*;
  - else the cached AI answer for this sentence equals them = *Disusun AI*;
  - else *Disunting*.

  The list shows it, and Riwayat keeps it.

## Acceptance criteria
- [ ] With no instruction, imports, controls and reports are exactly as today. The demo seeds identically, `verify:books` is ALL PASS, and
      the investor walk and existing e2e pass unchanged. → DB: `tests/db/instructions-import.test.ts` "no instruction = today"; the
      existing pipeline and golden tests unchanged; full gate.
- [ ] The parser compiles each supported shape, with direction, account by code or exact name, tax tag, every amount form and both
      operators. Each refused shape returns its Bahasa message, and an unrecognised sentence returns "Buku belum memahami kalimat ini." →
      unit: `tests/unit/instruction-parse.test.ts`.
- [ ] The validation is one closed schema for parser and AI output alike. It refuses unknown keys, a generic keyword, a keyword under 3 or
      over 60 characters, a non-classifiable or transfer account, an account no chart in scope has, and a duplicate or conflicting active
      instruction. → unit: `instruction-parse.test.ts` (schema); DB: `tests/db/instructions.test.ts` (charts, duplicates).
- [ ] The preview for "biaya admin bank selalu 6190" on the demo firm:
      - finds nothing literally and offers *BIAYA ADM*;
      - with it, counts Grup Ayam's and CV Sinar's monthly BIAYA ADM / BIAYA ADM BULANAN lines per month, all "sekarang di 7100";
      - names the clients whose chart lacks 6190, if any;
      - writes nothing.

      → DB: `instructions.test.ts` "preview" (no row written, counts equal to a direct query); e2e flow 1.
- [ ] *Setujui* on an *Aturan akun* makes one `Rule` (source INSTRUKSI, priority 5, `instructionId`, firm or client scope). The next import
      posts a matching line to 6190 with RULE 97 % and the reason `Instruksi kantor: keterangan memuat "BIAYA ADM"`. The lines posted
      before are unchanged. A client rule on the same text still wins in its client. → DB: `instructions-import.test.ts`; e2e flow 2.
- [ ] With the dial's *Aturan* off, a line an instruction rule matches waits in Review like any rule match. → DB:
      `instructions-import.test.ts`.
- [ ] *Tandai* "pengeluaran > Rp10 jt":
      - Tutup Buku of an open month shows one REVIEW control per entity listing the lines above Rp 10.000.000. A line of exactly Rp
        10.000.000 is not listed, and is listed under "minimal Rp10 jt".
      - It is PASS when none qualify, and a note clears it until the list changes.
      - A locked month has no such control.

      → DB: `tests/db/instruction-controls.test.ts`; e2e flow 2.
- [ ] *Tahan di Review* "PT MAJU JAYA selalu ke Review": a line rules or memory would post waits on 1999 with its suggestion and
      "Ditahan instruksi kantor …". It is in Kotak (*Klasifikasi bank*), never in *Setujui N usulan yakin*, and counted in "N ditahan
      Otomasi kantor (instruksi kantor)". A held transfer pair stays linked. → unit: `tests/unit/dial.test.ts` (hold by instruction);
      DB: `instructions-import.test.ts`; e2e flow 2.
- [ ] *Matikan* deletes the instruction's `Rule` and drops its control and hold for what comes next. No posted line, Review line or note
      changes, and the instruction shows as *Dimatikan*. → DB: `instructions.test.ts`, `instructions-import.test.ts`.
- [ ] No free text at run time: an import, `runControls` and the preview with active instructions of every kind make zero provider calls
      (`MockProvider.calls === 0`). → DB: `instructions-import.test.ts`, `instruction-controls.test.ts`.
- [ ] *Susun dengan AI* (MockProvider):
      - a valid answer becomes a draft marked *Disusun AI*;
      - an answer with an unknown key, a pattern not in the sentence, an amount not in the sentence or an account outside the whitelist
        is refused;
      - the second ask is a cache hit with no new call or budget;
      - an exhausted budget returns the budget message;
      - without a key the button is absent.

      → DB: `tests/db/instruction-ai.test.ts`; e2e flow 4 (no button without a key).
- [ ] Origin on approval is *Disusun Buku*, *Disusun AI* or *Disunting*, decided on the server. → DB: `instruction-ai.test.ts`,
      `instructions.test.ts`.
- [ ] Permissions:
      - Pemilik and Admin approve and turn off *Semua klien* and client instructions;
      - an assigned Akuntan does so for its client, and is refused for *Semua klien* with "Hanya admin kantor yang dapat mengubah ini.";
      - an unassigned client is refused as missing;
      - Peninjau is refused with its role message;
      - read-only and support sessions are refused.

      → DB: `tests/db/instruction-actions.test.ts`; e2e flow 3.
- [ ] Each approval and each *Matikan* writes one "Instruksi kantor" event, with before and after, in every client of the firm
      (*Semua klien*) or in the one client. → DB: `instructions.test.ts`; e2e flow 1.
- [ ] Pengaturan klien → *Klasifikasi & AI* marks instruction-made rules "Instruksi kantor" with a link to the instruction. → e2e flow 2.
- [ ] Works at 390 px without sideways page scroll (list, editor, preview). → e2e `instruksi-kantor.spec.ts`.
- [ ] Deck claims to review in ship:
      - `kantor.html` slide 07 *Review* ("aturan dan memori klien dibukukan langsung") gains that a firm writes its own rules in one
        sentence, approved before they run;
      - slide 11 *Tutup buku* gains the firm's own checks.

      `docs/demo/investor-demo.md` is unchanged.

## Verify flows
1. **Admin, demo firm, Pengaturan kantor → *Instruksi*.** Type "biaya admin bank selalu 6190", scope *Semua klien*, *Susun*.
   - The preview shows "Belum ada mutasi yang memuat "BIAYA ADMIN BANK"" and the hint *BIAYA ADM*. Click it.
   - The sentence reads "Mutasi keluar … "BIAYA ADM" → 6190 …", with per-client month counts and "sekarang di 7100 (aturan kantor BIAYA
     ADM)".
   - *Setujui*: the list shows it *Aktif*, *Disunting* (the keyword was changed), with who and when. Every client's Riwayat has the event.
     Jurnal Umum and Review read exactly as before.
   - *Matikan* it again (the demo's later import flows stay as seeded).
2. **Admin, own organisation ("KAP Uji Lain"), a QA client.**
   - Approve `"BIAYA ADM" selalu 6190` (client), "tandai pengeluaran > Rp10 jt" (client) and "PT MAJU JAYA selalu ke Review" (client,
     with a client rule for PT MAJU JAYA made in Review first).
   - Import a fixture with BIAYA ADM, a Rp 25.000.000 and a Rp 10.000.000 payment, and a PT MAJU JAYA payment.
   - Expected:
     - BIAYA ADM posts to 6190 with the instruction reason;
     - the result reads "1 ditahan Otomasi kantor (instruksi kantor)", and the PT MAJU JAYA line is in Review and Kotak with "Ditahan
       instruksi kantor …";
     - Tutup Buku lists the Rp 25 jt line, not the Rp 10 jt one;
     - a note clears the control;
     - Pengaturan klien marks the 6190 rule "Instruksi kantor".
3. **Akuntan, then Peninjau.**
   - The Akuntan sees the *Instruksi* tab, writes and approves an instruction for an assigned client, and sees *Semua klien* instructions
     without *Matikan*. A crafted *Semua klien* approval is refused.
   - The Peninjau sees the list only: no editor, no *Matikan*.
4. **Edge.**
   - "akrualkan sewa Rp 5 jt setiap bulan" → the journal refusal. "TRANSFER selalu 6190" → the generic-keyword refusal. "BIAYA ADM
     selalu 1999" → the account refusal.
   - With no AI key, "kalau ada yang aneh kabari saya" → "Buku belum memahami kalimat ini." and the patterns, with no *Susun dengan AI*.
5. **Error.** Approving the same *Aturan akun* twice → "Sudah ada instruksi aktif …", and nothing is stored. Editing the account to a code
   not in the chart → a field message; *Setujui* stays disabled until the preview is current.

## UX notes
- **Place.** Pengaturan kantor gets a tab *Instruksi*, between *Umum* and *Tim*. It is visible to every role, so non-admins now see tabs:
  *Umum* | *Instruksi*.
  - NextStep: "Tulis kebiasaan kantor dalam satu kalimat. Buku menyusunnya menjadi aturan pasti; Anda memeriksa contohnya lalu
    menyetujui."
- **Editor card** *Instruksi baru* (writers only):
  - one text input (≤ 300 characters), placeholder "mis. biaya admin bank selalu 6190";
  - *Berlaku untuk*: *Semua klien* (admins only) or a client, from the clients the member may open;
  - *Susun* (primary);
  - a muted line under it with the three patterns: "Aturan akun: <kata kunci> selalu <akun> · Tandai: tandai pengeluaran > Rp10 jt ·
    Tahan: <kata kunci> selalu ke Review".
- **Preview card** (replaces the editor's primary):
  - an eyebrow with the kind and the origin (*Disusun Buku* / *Disusun AI*);
  - the compiled sentence;
  - the editable fields: *Kata kunci* (monospace), *Arah* (*Uang keluar* / *Uang masuk* / *Keduanya*), *Akun* (the `AccountPicker`),
    *Pajak*, *Nominal* with *di atas* / *minimal*;
  - keyword hints as small outline buttons;
  - notes (conflicts, clients skipped) as one sentence each;
  - the matched lines: a count row per client and month, then up to 20 lines in a table (date, client, keterangan in monospace, amount
    `.num` right-aligned, akun sekarang; client and akun hidden below `md`);
  - the footer line, then *Setujui* (primary) and *Batal* (ghost).
  - An AI-compiled draft shows "Disusun AI — periksa setiap isian sebelum menyetujui." in the review colour.
- **List card** *Instruksi aktif*:
  - divided rows, no boxes in boxes;
  - each row: the sentence in quotes, the compiled sentence muted, the kind and scope eyebrow, "Disetujui <tanggal> oleh <nama>" and the
    origin, and *Matikan* (outline, with a confirm dialog naming what stops);
  - *Dimatikan* instructions fold into "N dimatikan".
  - Empty state: "Belum ada instruksi. Aturan bawaan Buku dan aturan dari Review tetap berlaku."
- **Refusals** show under the input as the error text, verbatim, with the pattern line kept visible.
- **Copy.** Bahasa only. No "prompt", "compile" or "rule engine": *susun*, *aturan*, *tandai*, *tahan*.

## Test seams
- **Unit (pure):**
  - the parser: shapes, amounts, operators, direction inference, refusals;
  - the closed-schema validator;
  - the keyword hint (prefix match);
  - the post-or-hold decision with instruction holds (extend `tests/unit/dial.test.ts`), and `heldLine` with the new label.
- **DB:**
  - preview: read-only, counts, the matcher equal to `matchRule`, skipped charts;
  - approve and *Matikan*: `Rule` row, `instructionId`, events per client, origin, duplicates and conflicts, under a firm row lock as
    `saveAutomation`;
  - the import with each kind, the dial interplay and zero provider calls;
  - controls: open versus locked month, boundary amount, note and stale note;
  - AI compile with `MockProvider`: grounding, cache, budget, refusals;
  - actions: every role and access state;
  - client deletion removes its instructions (extend the client-delete test).
- **E2E:** `e2e/instruksi-kantor.spec.ts`.
  - Flows 2, 3 and 5 in "KAP Uji Lain" (the e2e-setup second organisation), so the demo firm's rules never change under parallel specs.
  - Flow 1's preview on the demo, read-only. Its approve and *Matikan* run serially and restore in `finally`.
  - 390 px.

## Non-goals
- Instructions over ledger-imported or manual journal lines; *Tandai* on accounts or balances ("tandai saldo kas < Rp 0").
- Re-classifying, re-posting or holding lines already imported when an instruction is approved or turned off.
- Editing an active instruction in place; re-activating a turned-off one (write it again).
- Drafts stored on the server, or instruction drafts in Kotak persetujuan.
- Otomatis checklist tasks from instructions (Checklist tutup buku); approval routing (Phase 3 item 2); flux as a close step (item 4).
- AI that reads bank descriptions to find a keyword; any AI at classification or control time.
- A rule editor for the seeded firm rules or Review-made client rules beyond marking their origin.
- Per-instruction statistics ("matched N lines since approval").

## Assumptions
- **Bank lines are Rupiah** (the pipeline refuses others), so amounts compare exactly in whole Rupiah.
- **The preview's months** are, per client, its latest three months with bank lines, so a lagging client still shows examples. The
  preview reads at most those months of the clients in scope.
- **A bank line keeps no FK to its rule**, as today. The trail is the reason text naming the instruction, plus `Rule.instructionId` from
  the rule tables.
- **Priority 5** puts an instruction rule before every seeded firm rule. That is the point: the firm's word beats Buku's starter list. The
  preview shows each displaced rule before approval.
- **A *Tandai* control is computed at read time** like every control, and is not added to a locked month. Reopening a month shows it.
- **One event per client per change**, as *Otomasi kantor*. A firm holds tens of clients. A client added later starts without earlier
  events.
- **Deleting a client** deletes its own instructions and their rules, as it deletes its rules today. *Semua klien* instructions stay.
- **AI compile payload** is the sentence and account names only, like account mapping (rule 17). A note on ADR 0003 records it, and no
  new ADR is needed: it is reversible and follows ADR 0020 §2.
- **Open for the owner** (the recommended answer is the one written above):
  1. **Who may approve a one-client instruction.** The recommendation is `books.write` on that client (assigned Akuntan included), the same
     power Review's *Selalu gunakan akun ini* already gives. The alternative is admins only for every instruction.
  2. **Keyword hints.** The recommendation is the deterministic prefix hint, because the roadmap's own example matches nothing literally.
     The alternative is no hints: the accountant edits the keyword from the preview's empty result.
  3. ***Tahan di Review* in v1.** The recommendation is to include it: it can only send more to Review and reuses the dial's hold path. The
     alternative is v1 with *Aturan akun* and *Tandai* only, *Tahan* in a follow-up.

## Gate re-openers
- **Migration (planned, additive):**
  - **A new `Instruction` table:** firm, optional client, the sentence, kind (ACCOUNT | FLAG | HOLD), status (ACTIVE | OFF), origin
    (PARSER | AI | EDITED), the compiled fields as typed columns (pattern, direction, account code, tax tag, minimum amount as bigint,
    inclusive), approved by and at, turned off by and at.
  - **CHECKs:**
    - per kind: ACCOUNT needs a pattern and an account, and has no amount; FLAG needs an amount; HOLD needs a pattern;
    - amount > 0;
    - sentence 1–300 characters;
    - OFF ⇔ turned-off time set.
  - **`Rule.instructionId`:** nullable, unique, FK with Restrict.
  - No backfill. It goes under `prisma/migrations/**`, a sensitive path.
- **Accounting invariant text changes:**
  - rule 13: instruction rules, priority 5, the reason;
  - rule 14: instruction holds, stricter only;
  - a new 22c: *Tandai* controls;
  - a new 20e: the compile payload, closed schema, grounding, approval by a person, never at run time.

  Invariant 4 is unchanged.
- **New paid AI path:** *Susun dengan AI*, on click only, budgeted, cached, no retry; tests and seed use `MockProvider`. No real call in this
  cycle, and `ai:smoke` is not extended.
- **Sensitive paths touched:**
  - `prisma/migrations/**`;
  - a new `app/instruction-actions.ts`, guarded per scope by `requireCapability("org.settings")` or
    `requireCapability("books.write", { clientId })`.

  The permission matrix is unchanged.
- **Reports:** no number moves without an instruction (`verify:books` ALL PASS). An approved *Aturan akun* changes where future imports
  post, and a *Tandai* adds a REVIEW control, by design.
- **None of the rest:** no dependency, no production write.

If the hold needs to be stored on the bank line (a new column) rather than in its reason, that is a second migration: stop and ask.

## Tasks
- [x] T1 Schema + migration (`Instruction`, enums, CHECKs, `Rule.instructionId`). `AuditKind` INSTRUCTION + label + Riwayat filter.
      Client deletion removes its instructions. Accept: migration applies on a fresh and a seeded DB; DB CHECK tests; client-delete
      test. (reuse: `recordEvent`)
- [x] T2 `lib/instructions/`: the parser, amount reader, closed-schema validator and keyword hint (pure); the preview (read-only); approve
      and *Matikan* (firm row lock, `Rule` write or delete, events, origin). Accept: unit parse tests + DB `instructions.test.ts`. (deps:
      T1; reuse: `matchRule`, `sortRules`, `isGenericKey`, `isClassifiable`, `aiAccounts`, `parseMoney`, `formatRupiah`)
- [x] T3 Run time: the instruction rule's reason in `matchRule`; holds in the post-or-hold decision and the pipeline (`heldBy`
      "instruksi kantor"); *Tandai* controls in `runControls` (open months, notes) and their rows in the AI close review; accounting-rules
      13, 14, 22c. Accept: `dial.test`, `instructions-import.test.ts`, `instruction-controls.test.ts`; existing pipeline and control
      tests unchanged. (deps: T1, T2; parallel with T4)
- [x] T4 *Susun dengan AI*: provider method + prompt + parse (closed schema, grounding), `MockProvider.compileInstruction`, budget +
      cache; accounting-rules 20e; note on ADR 0003. Accept: `instruction-ai.test.ts`. (deps: T2; parallel with T3; reuse:
      `runBudgetedAi`, `EvidenceAiCache`, `resolveProvider`)
- [x] T5 UI + actions: the *Instruksi* tab (editor, preview, list, read-only), `app/instruction-actions.ts`, and the origin mark on
      Pengaturan klien's rule tables; README (routes, settings). Accept: `instruction-actions.test.ts`; flows 1, 3–5 on the dev server.
      (deps: T2–T4; reuse: `AccountPicker`, `NextStep`, `LinkTabs`, the `AutomationCard` layout)
- [ ] T6 verify-local: walk flows 1–5 with screenshots at 1440 and 390 px; `e2e/instruksi-kantor.spec.ts`; the full gate (`demo:reset`,
      `verify:books` ALL PASS). (deps: T3–T5)

## Implementation
- Plan: T1 → T2 → T3 → T4 → T5 sequential, inline in one build worker (each task reads the previous one's module: the parser and
  validator feed the preview, the run time, the AI compile and the actions; a fan-out would cost more context than it saves). T6's e2e
  spec is written here; the walk, screenshots and the full gate with `demo:reset` / `verify:books` / Playwright run in the driver's
  verify-local (this worker never touches the shared `buku` database).
- T1: `prisma/schema.prisma`, `prisma/migrations/20261018130000_instructions/`, `lib/audit.ts`, `lib/clients/delete.ts`,
  `.agents/skills/accounting-rules/SKILL.md` (rule 25), `tests/db/instructions.test.ts`, `tests/db/delete-client.test.ts` — the
  `Instruction` table (three enums, typed compiled columns, approved/turned-off by and at), `Rule.instructionId` (unique, Restrict) and
  CHECKs per kind, keyword (upper case, 3–60), amount > 0, sentence 1–300 and not blank, OFF ⇔ `offAt`. `Instruction.clientId` is
  Restrict (never Set Null: a deleted client's instruction must not turn firm-wide); client deletion removes its rules, then its
  instructions, and keeps *Semua klien* ones. `INSTRUCTION` ("Instruksi kantor") joins the Riwayat label map, so the filter chip follows.
- T2: `lib/instructions/compile.ts` (pure), `lib/instructions/match.ts`, `lib/instructions/preview.ts`, `lib/instructions/store.ts`,
  `lib/classify/rules.ts`, `tests/unit/instruction-parse.test.ts`, `tests/db/instructions.test.ts` — the reader (refusals first, on the
  text outside a quoted keyword; then *Tandai* / *Tahan* / *Aturan akun* by their verbs), the bigint amount reader (units jt/juta,
  rb/ribu, M/miliar; thousands dots; a decimal comma, or a dot only with a unit; a fraction of a Rupiah refused), and `validateDraft`, the
  one closed schema for the reader, the AI and the accountant's edits (exact keys, per-kind fields, keyword 3–60 and not generic, a
  classifiable non-transfer account in a chart in scope, an amount 1…10¹⁵−1). `winningRule` is `matchRule`'s decision returning the
  rule itself, so the preview runs the import's own matcher with the proposed rule added; `matchRule` keeps its result and words a rule
  from an instruction "Instruksi kantor: keterangan memuat …". The preview reads each client's latest three months with bank lines and
  writes nothing; keyword hints come from the scope's rule patterns and merchant keys, ranked by typed words covered, then lines.
  Approve and *Matikan* run under the firm's row lock (as `saveAutomation`), refuse a duplicate (an *Aturan akun* on the same keyword,
  direction and scope with any account counts as one), write the Rule (priority 5, `INSTRUKSI`) or delete it, and one event per client
  (before/after snapshots, amounts as strings). Origin is decided on the server: the reader's own result, else a cached AI draft for the
  same sentence (`EvidenceAiCache`, scope `instruksi:<firm>`), else *Disunting*.
- T3: `lib/classify/dial.ts`, `lib/instructions/match.ts`, `lib/import/pipeline.ts`, `lib/instructions/controls.ts`,
  `lib/controls/index.ts`, `lib/controls/ai-review.ts`, `.agents/skills/accounting-rules/SKILL.md` (13, 14, 22d),
  `tests/unit/dial.test.ts`, `tests/db/instructions-import.test.ts`, `tests/db/instruction-controls.test.ts` — the import reads the
  client's active *Tahan* instructions' typed fields into the dial; `decidePosting` checks them after the switches and the cap (stricter
  only; held kind `instruction`, "instruksi kantor" in the import result) against the lines a decision covers: the line, and for a
  transfer pair its other half, so both halves get one decision and a held pair follows the dial's existing pair rules. `runControls`
  adds one *Tandai* control per entity and active FLAG instruction unless the month is locked (`matchesLine` over the month's bank
  lines, five shown then "+N lainnya", PASS "Tidak ada …"); notes and stale notes work as for every REVIEW control. The AI close review
  (and so *Jelaskan* and *Lihat alasan*) sends a *Tandai* control's listed lines through the existing `bankRow`/caps.
  - Decision: the control key is `instr:<entity>:<instruction>`, not the spec's `instr:<instruction>:<entity>`: every entity-scoped
    control key in Buku is `kind:<entityId>…`, and the close review, *Jelaskan* (draft only for an entity's control) and *Lihat alasan*
    find the entity from the second segment. Nothing else reads the order.
  - Decision: the new close rule is numbered 22d: 22c already exists (source validation).
- T4: `lib/instructions/ai-prompt.ts`, `lib/instructions/ai.ts`, `lib/ai/provider.ts`, `.agents/skills/accounting-rules/SKILL.md`
  (20e), `docs/adrs/0003-hybrid-ai.md` (note), `tests/db/instruction-ai.test.ts` — `compileInstruction` on the provider port (the
  OpenAI-compatible provider returns the model's text; `MockProvider.instructionAnswer` records one for tests, else NONE). `compileWithAi`
  asks only for a sentence the reader did not understand, sends the sentence and the targetable accounts (code and name, 1190/1199 out),
  and reads the answer with `readInstructionAnswer`: one object with exactly the draft's keys (else, or NONE: "AI juga tidak dapat …"),
  the keyword in the sentence (case and spaces ignored), the amount among `amountsIn(sentence)`, the account in the list, then
  `validateDraft`. One `runBudgetedAi` call (scope `instruksi:<firm>`, note "Instruksi kantor"), no retry; the answer, kept or refused,
  is cached by sentence, accounts, model and prompt version (the cache row also holds the sentence, which the origin check reads).
- T5: `app/instruction-actions.ts`, `app/(app)/settings/page.tsx`, `components/app/instruction-editor.tsx`,
  `components/app/instruction-list.tsx`, `lib/instructions/labels.ts`, `app/(app)/clients/[id]/settings/page.tsx`, `README.md`,
  `tests/db/instruction-actions.test.ts` — five actions, each behind the scope's guard (`org.settings` for *Semua klien*,
  `books.write` on the client otherwise; *Matikan* reads the instruction in the firm first, then guards by its own scope). *Susun* and
  the preview validate and read only; `Setujui` is the one write. The *Instruksi* tab (between *Umum* and *Tim*, every role) holds the
  NextStep, the editor for members who may approve in some scope (*Semua klien* for admins, then the clients they may open), and the
  list: divided rows with the sentence, the compiled sentence, kind and scope, "Disetujui … oleh … · origin", *Matikan* with a confirm
  naming what stops, and "N dimatikan" folded. The editor's preview is the approval screen: every field editable (keyword, direction,
  account via `AccountPicker`, tax tag, amount and operator); an edit marks it stale ("Perbarui contoh") and *Setujui* stays off until
  the preview is current or while a duplicate blocks it; hints are outline buttons that re-preview; matched lines show per client and
  month, then up to 20 rows (client and current account hidden below `md`). The words and shapes the client component needs live in
  `lib/instructions/labels.ts` (no server-only imports). Pengaturan klien's rule tables mark an instruction rule "Instruksi kantor",
  linked to its row on the list.
- T6 (part): `e2e/instruksi-kantor.spec.ts` — three tests. (1) Demo firm, demo admin: flow 1's preview (no literal match, the
  *BIAYA ADM* hint, "sekarang di akun lain (7100", Grup Ayam Nusantara and CV Sinar Retail counts, 390 px), *Setujui* (Aktif,
  *Disunting*, Riwayat of Grup Ayam), flow 3's Akuntan (tab visible, no *Tim*, no *Semua klien* scope, the firm row without *Matikan*,
  writes, approves and turns off its own instruction on PT Jasa Kreatif Digital) and Peninjau (`asPeninjau`: list only, no editor, no
  *Matikan*, 390 px); every instruction it made is turned off in `finally`, and a leftover from an interrupted run is turned off first.
  (2) Flow 4's refusals verbatim with the pattern line, and no *Susun dengan AI* (precondition asserted: "Usulan AI belum aktif").
  (3) "KAP Uji Lain" on a client of its own: flow 2 (four client instructions; the import's "1 ditahan Otomasi kantor (instruksi
  kantor)"; BIAYA ADM on 6190 with the instruction reason in the ledger drawer; PT MAJU JAYA in Review and Kotak, no bulk accept;
  Tutup Buku lists the Rp 25 jt line and not the Rp 10 jt one; a note clears it; the rule marked "Instruksi kantor" with its link;
  four Riwayat events) and flow 5 (the duplicate blocked before *Setujui*; an edit makes the preview stale; a 2-letter keyword's field
  message). Clients and options are picked by exact name; every action is awaited through its toast or the refreshed row. Not run
  here: the walk, screenshots, `demo:reset`, `verify:books` and Playwright are the driver's verify-local (this worker never touches the
  shared `buku` database).
  - Decision: flow 2's PT MAJU JAYA rule is an approved *Aturan akun* (`"PT MAJU JAYA" selalu 6120`) rather than one made in Review: it
    holds a line a rule would post the same way, and the Review-made (USER) rule is covered by `instructions-import.test.ts`.
  - Decision: flow 5's "account not in the chart" cannot be typed in the UI (the *Akun* picker offers only the scope's chart); the field
    message is asserted at the action (`instruction-actions.test.ts`, `instructions.test.ts`), and the e2e asserts the keyword's.
- **Criteria → tests** (owner's ask: every criterion asserted at least once):
  - No instruction = today → `instructions-import.test.ts` ("no instruction = today …": hardcoded per-line outcome, no `instr:`
    control, and instructions approved then turned off import identically, controls included); `instructions.test.ts` (preview writes
    nothing); existing pipeline / dial / golden / demo tests unchanged in the full run; `verify:books` and the investor walk at verify-local.
  - Parser shapes, amounts, operators, refusals, "Buku belum memahami" → `tests/unit/instruction-parse.test.ts`.
  - One closed schema (unknown keys, generic keyword, 3–60, non-classifiable / transfer account, charts, duplicates) →
    `instruction-parse.test.ts` ("the closed schema"), `instructions.test.ts` ("refuses what the closed schema refuses …", duplicate in
    "an Aturan akun for Semua klien …"), `instruction-ai.test.ts` (the AI's answer through the same validator).
  - Preview for "biaya admin bank selalu 6190" (nothing literal, the *BIAYA ADM* hint, counts per month equal to a direct query, all
    on 7100, skipped charts named, nothing written) → `instructions.test.ts` "preview (read-only)"; e2e test 1.
  - *Setujui* makes one INSTRUKSI Rule (priority 5, `instructionId`, scope); the next import posts to 6190 RULE 97 % with the reason;
    lines before unchanged; a client rule still wins → `instructions.test.ts`, `instructions-import.test.ts` ("an approved Aturan akun
    …", "a client rule on the same text …"), `tests/unit/import.test.ts` (matchRule unchanged for other rules); e2e test 3.
  - Dial *Aturan* off holds an instruction rule's line → `instructions-import.test.ts` ("with the dial's Aturan off …").
  - *Tandai* (one REVIEW control per entity, exactly Rp 10.000.000 excluded and included under *minimal*, PASS, note and stale note,
    no control in a locked month) → `tests/db/instruction-controls.test.ts`; e2e test 3.
  - *Tahan di Review* (1999 with its suggestion and "Ditahan instruksi kantor …", Kotak not bulk, "N ditahan … (instruksi kantor)",
    the pair stays linked) → `tests/unit/dial.test.ts` ("hold by instruction"), `instructions-import.test.ts`; e2e test 3.
  - *Matikan* (rule deleted, control and hold dropped, nothing posted or noted changes, *Dimatikan*) → `instructions.test.ts`
    ("Matikan deletes the rule …"), `instructions-import.test.ts` (turned off = never approved), `instruction-controls.test.ts` (control
    gone, old note kept); e2e test 1.
  - Zero provider calls at run time → `instructions-import.test.ts` ("no free text at run time": import, `runControls` and three
    previews with every kind active; `MockProvider.calls === 0`, no `fetch`, no `AiUsage`), `instruction-controls.test.ts` (no `fetch`).
  - *Susun dengan AI* (draft, refusals, cache hit without call or budget, budget message, no key) → `instruction-ai.test.ts`,
    `instruction-actions.test.ts` (no model); e2e test 2 (no button without a key).
  - Origin decided on the server → `instructions.test.ts` ("origin: …"), `instruction-ai.test.ts` (*Disusun AI*, *Disunting*); e2e test 1.
  - Permissions (Pemilik/Admin, assigned Akuntan and its refusal for *Semua klien*, unassigned client, Peninjau, read-only, support
    session) → `tests/db/instruction-actions.test.ts`; e2e test 1 (Akuntan, Peninjau).
  - One "Instruksi kantor" event per approval and *Matikan*, per client in scope → `instructions.test.ts`; e2e tests 1 and 3.
  - Pengaturan klien marks the rule → e2e test 3.
  - 390 px (list, editor, preview) → e2e tests 1, 2 and 3, unconditional.
  - Deck claims → ship (deck review), no test.
- Build worker's gate (on `e32cdcd`, isolated database `buku_test_a`): `npm run lint` and `npm run typecheck` exit 0; full `npm test`
  "Test Files 1 failed | 315 passed (316) · Tests 2858 passed (2858)", the one file being `tests/db/db-drift.test.ts`'s afterAll hook
  timing out on its fixed-name database `buku_drift_check` while another worker used it; re-run alone once that database was free:
  "Test Files 1 passed (1) · Tests 3 passed (3)". `npm run build` exit 0. Not run here (shared `buku` database): `demo:reset`,
  `verify:books`, Playwright and the walk.

## Verification

## Ship Notes
