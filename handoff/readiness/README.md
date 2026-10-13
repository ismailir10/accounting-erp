# Source patch handoff

Base: `9c6c0ded246f4e9738ebedfbc598bddaf3c66a52`. Source head: `c1c561210c1ef7119d87a2904a2ead598f5e96f9`.

Transfer-only branch: do not merge this branch. Apply the six raw zero-context diffs in filename order to a separate integration candidate with `git apply --index --unidiff-zero <patch>`.

The code sections are unchanged from the source set. Mail headers, hunk descriptions and documentation sections are excluded.

| File | Bytes | SHA256 |
|---|---:|---|
| `u0-0001-fix-clients-ask-the-bookkeeping-currency-of-a-ledger.patch` | 13904 | `497e56f7f219bba36fef5d57aeafaeac48031157622c63b4c878c2b38cd4a7a5` |
| `u0-0002-fix-ledger-import-round-a-sub-sen-source-amount-once.patch` | 10722 | `092d7992577d60391887e36a266bf043eec049a497659d19efe3de5496e3cece` |
| `u0-0003-fix-import-list-a-foreign-account-that-only-a-consol.patch` | 5943 | `a4ff5518440edf06a0040f02962b62679357a4a4294acecff19e0eb8b564352a` |
| `u0-0004-test-clients-pin-the-limit-of-the-ledger-currency-qu.patch` | 741 | `2c43b38655f1ecfb7e1f3624017e2c615719276c2cc508a4aa159ed960446b95` |
| `u0-0005-fix-ledger-import-round-from-the-exact-source-amount.patch` | 23932 | `6fe188289c0e0f1a14fb0baf3dbf6d425178f2ef5a74b5efe4aeb02281693983` |
| `u0-0006-fix-ledger-import-round-a-trial-balance-s-exact-amou.patch` | 12081 | `ff96bc888480a90ca201747e45be56eceef17cb97efdba37f2fb980de4ed3545` |
