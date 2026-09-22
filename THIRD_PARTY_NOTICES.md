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

`docs/unified/dependency-audit.json` records the actual runtime Node closure from the explicit
installed roots `vendor/zvec-grep/node_modules`, `vendor/codegraph/node_modules`, and
`packages/core/node_modules`. The root `node_modules` tree is retained separately as a development
baseline; it is not substituted for the vendored runtime closure. Traversal follows only installed
package directories and nested `node_modules` directories, so fixture subtrees and arbitrary
`package.json` files are not treated as dependencies.

The audit records each Node package's declared licence metadata, adjacent packaged licence/notice
files, install-script marker, real path, and SHA-256 hashes. Missing declared metadata is a failure,
not a silently passing root-only result. It also reads all 36 installed Python distributions from
`workers/semantic/.venv`, retaining `License-Expression`, `License`, licence classifiers, and
existing `.dist-info` licence/notice files with resolved paths and SHA-256 hashes. The Python audit
has no intentionally discarded `license_files` field.

Native binaries and the 134 retained tree-sitter grammar WASM assets are retained only when the audit can point to their actual packaged or upstream notice. Copied pinned-source WASM under `vendor/codegraph/{src,dist}` maps to `vendor/codegraph/node_modules/tree-sitter-wasms/LICENSE`; packaged WASM maps to its own package licence, with the per-asset path, real path, and SHA-256 in the audit. The top-level `THIRD_PARTY_NOTICES.md` is an index and is not counted as per-asset coverage. The installed closure includes copyleft software (for
example `@img/sharp-libvips-darwin-arm64` under LGPL-3.0-or-later); its licence is retained in the
installed package and is listed by the audit, not silently treated as permissive.

The configured `local/qwen3-embedding-0.6b` model is external cached state. No model or model-weight
artefact is retained or redistributed by this checkout, and the audit does not scan unrelated home
directories or download one. Runtime attribution and the external model licence reference are
retained in `docs/unified/dependency-audit.json` under `external_runtime_model`; see the Qwen3
Embedding model reference at <https://huggingface.co/Qwen/Qwen3-Embedding-0.6B>.

`node scripts/verify-dependencies.mjs --write docs/unified/dependency-audit.json` regenerates the
machine-readable inventory from those bounded installed roots without installing, resolving,
contacting a registry, loading a model, or changing model configuration.

## External cached embedding model licence

The configured runtime embedding is `local/qwen3-embedding-0.6b`. It is an external cached model and is **not retained or redistributed** by this repository. The model card identifies the Qwen3-Embedding-0.6B model as Apache-2.0 licensed and attributes it to the Qwen Team:

- Model card/source: <https://huggingface.co/Qwen/Qwen3-Embedding-0.6B>
- Model-card revision observed: `97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3`
- Exact upstream licence source used for this notice: <https://huggingface.co/Qwen/Qwen3-0.6B/blob/c1899de289a04d12100db370d81485cdf75e47ca/LICENSE>
- Licence source revision: `c1899de289a04d12100db370d81485cdf75e47ca`
- Licence source SHA-256 (UTF-8 bytes): `832dd9e00a68dd83b3c3fb9f5588dad7dcf337a0db50f7d9483f310cd292e92e`

The exact Apache-2.0 text retrieved from that pinned upstream source follows:

```text

                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "[]"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

   Copyright 2024 Alibaba Cloud

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
```
