# Changelog

## 2.0.0

- OpenCode V2-only plugin (`@opencode/plugin` 2.2.2). The V1 `server()` export is removed.
- 14 native notebook tools with JSON Schema inputs, permission assertions, and V2 result metadata.
- Real-path path confinement, symlink-alias locking, and atomic notebook writes.
- Notebook LSP support: virtual Python document, cell mapping, post-edit/on-demand
  pyright diagnostics, and a materialized `.py` sidecar for per-cell hover,
  go-to-definition, find-references, and document symbols through
  `opencode-v2-lsp-support`. Sidecars live next to the notebook
  (`opencode-ipynb-lsp-<hash>.py`) so sibling imports resolve; add
  `opencode-ipynb-lsp-*.py` to `.gitignore`.
- Token-efficient `ipynb_edit` results (no echoed source or diff).
- Warm-kernel source reload, per-request timeouts, abort handling, and startup timeouts.
- `allowOutsideWorktree` escape hatch preserved for notebook reads/writes and exports.
- Services migrated to Effect **4.0.6**, matching OpenCode 2's plugin SDK.
- New `docs/architecture.md`, `docs/contributing.md`, a CI workflow, and an
  `opencode.example.jsonc` template.

### Breaking changes

- V1 OpenCode is no longer supported. Use plugin `0.1.2` with OpenCode 1.
- `ipynb_edit` no longer returns a textual old/new/diff body; it returns a concise
  confirmation plus diagnostics.
- LSP diagnostics use a 0-based cell index and 1-based line/character positions in human-readable text.
- Read-only notebook tools (`ipynb_inspect`, `ipynb_read`, `ipynb_repro`) now declare and assert the V2 `read` action; mixed tools assert `read`/`edit` per branch.
- `ipynb_kernel restart` stops the current kernel; the next run starts a new one (it does not respawn eagerly).
- `helperRelativePath` is now resolved only relative to the plugin package or as an absolute path; it is no longer searched in the project cwd/worktree (prevents helper shadowing).
- `ipynb_run save=true` requires an `edit` permission in addition to `shell`,
  and the edit is asserted before user code runs. A denied edit executes nothing.
- `ipynb_run` now defaults `maxOutputChars` to `defaultMaxOutputChars` (6000),
  matching the other read tools. Pass `maxOutputChars` explicitly for larger output.

## 0.1.2

- Final V1 release. See the repository history for the V1 feature set.
