# Third-party notices

lazy-intel orchestrates these upstream projects without copying or modifying their source trees:

- zvec-grep (`@zvec/zvec-grep` 0.2.1), Apache-2.0, https://github.com/zvec-ai/zvec-grep
- CodeGraph (`@colbymchenry/codegraph` 1.6.0), MIT, https://github.com/colbymchenry/codegraph
- Serena (`serena-agent` 1.7.0), MIT, https://github.com/oraios/serena

Their own licenses govern those packages. `npm install` resolves the two Node packages; `scripts/install.sh` installs the pinned Serena package through `uv`.
