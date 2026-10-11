# 0018 — PDF passwords are remembered per client

**Status.** Accepted, 2026-10-11 (cycle [unggah-inbox](../cycles/2026-10-10-unggah-inbox.md); approved 2026-10-10).
Replaces the rule "the PDF password is used once to open the file and never stored" (import actions, accounting-rules,
the decks' security slide).

**Context.** Indonesian banks lock e-statements with a password the customer chose or the bank derived (often a birth
date). A firm uploads the same client's statements every month, and one client can have several passwords (one per
bank or per owner). Asking for the password on every file — 13 prompts for one client's folder in the 2026-10-10 test —
makes the user re-type a value Buku already saw, and the "one prompt per drop" alternative still asks again every
month.

**Decision.**
1. Each client has a **keyring**: every password that opened one of its PDFs is stored, encrypted with the settings
   secret (`encryptSecret`, AES-256-GCM, the same helper as the AI key and the Drive token), with who added it and when.
2. A locked PDF is tried against the client's keyring first. Only a file none of them opens asks for a password; the
   password that opens it joins the keyring. The prompt says so ("disimpan untuk klien ini").
3. Passwords never leave the server: they are not returned to the browser, not written to logs, URLs or error messages,
   and not sent to any AI provider. They are scoped to one client; another client's files never try them.
4. Admins of the organisation can see how many passwords a client has and clear them (Pengaturan klien). Clearing makes
   the next locked file ask again. Rotating `SETTINGS_SECRET` makes stored passwords unreadable; they are then ignored and
   the user is asked again (like the Drive token's "hubungkan ulang").
5. Deleting a client deletes its keyring (cascade).

**Consequences.** Monthly uploads of locked statements need no typing after the first month. The database now holds
secrets that open client bank statements: they get the same protection as the AI key (encryption at rest with a key
outside the database, server-only use) and a clear button. The public decks' "Kata sandi PDF hanya membuka file, tidak
disimpan" claim changes in the same PR.
