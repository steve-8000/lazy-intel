# Third-party notices

lazy-intel **vendors** the source of three upstream projects under `vendor/`. Each tree is an
unmodified import of a pinned commit; every later change is recorded as a `local_patches` entry in
that tree's `UPSTREAM.json` and is verifiable with `npm run verify:vendor`.

| Vendored tree | Upstream | Pinned commit | Release | Licence |
|---|---|---|---|---|
| `vendor/zvec-grep` | [zvec-ai/zvec-grep](https://github.com/zvec-ai/zvec-grep) | `309a66995809243d3274fa8b5bea63ab11dda1a0` | v0.2.1 | Apache-2.0 |
| `vendor/codegraph` | [colbymchenry/codegraph](https://github.com/colbymchenry/codegraph) | `dfccdf62547fcd76d343344d823a0e1998d3a89f` | v1.6.0 | MIT |
| `vendor/serena` | [oraios/serena](https://github.com/oraios/serena) | `949a27ef1e5fda1a6e7b561e777bcece345c6ffd` | v1.7.0 | MIT |

Each upstream `LICENSE` file is preserved inside its vendored tree and governs that code. The
Apache-2.0 tree additionally requires that modified files be marked as changed: every file lazy-intel
adds carries an `ADDED BY lazy-intel` header, and every file lazy-intel edits is listed in
`vendor/zvec-grep/UPSTREAM.json` with its original and resulting blob hashes.

## Files lazy-intel adds inside vendored trees

- `vendor/zvec-grep/src/lazy-entry.ts`
- `vendor/codegraph/src/lazy-entry.ts`

## Provenance of the imports

The imports are taken from the pinned Git commits, not from the published packages. That distinction
is load-bearing for CodeGraph: the published `@colbymchenry/codegraph@1.6.0` root package contains no
executable JavaScript. It is a thin installer (`npm-shim.js`) around a per-platform bundle that ships
its own Node runtime and can download a release archive from GitHub when the bundle is missing.

Both Node distributions were nevertheless shown to be faithful builds of the pinned source. Building
each pinned tree locally reproduces the shipped output byte for byte:

- `@zvec/zvec-grep@0.2.1` — 390/390 files in `dist/` identical.
- `@colbymchenry/codegraph@1.6.0` — 742/742 files in the platform bundle's `lib/dist/` identical,
  including all 29 tree-sitter grammars and `db/schema.sql`.

Details and method are in `docs/unified/distribution-provenance.json`.

## Transitive dependency licences

`docs/unified/dependency-audit.json` records the licence of every package in the installed Node
closure. One dependency is not permissive: `@img/sharp-libvips-darwin-arm64` is LGPL-3.0-or-later and
arrives through `@huggingface/transformers` → `sharp`. It is used as an unmodified, dynamically
linked prebuilt binary. Python transitive licences are not yet resolved; that is closed when the
private semantic worker's real import closure is fixed.
