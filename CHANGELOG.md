# Changelog

## Unreleased

- Writes are byte-stable (issue #2): the zod schemas now validate only, and the
  raw `JSON.parse` object is mutated, so no write re-emits the notebook in
  schema-declaration order. `src/utils/json-patch.ts` splices only the changed
  values into the stored text, so untouched bytes keep their key order, layout,
  escapes, and number literals.
- `ipynb_edit` mirrors the stored `source` shape: a notebook that stores line
  arrays keeps line arrays (split like nbformat/`splitlines(keepends=True)`); a
  single-string notebook keeps one string. Inserted cells inherit the shape of
  the notebook's first cell.
- `ipynb_run save=true` splits the `stream.text`/text-mime strings that
  `nbformat.read` rejoins when the notebook stores `source` as line arrays, so
  saving outputs does not reflow those outputs.
- Defaulted keys (`metadata`, cell `outputs`) are inserted in sorted position
  instead of appended, so they do not break nbformat's key order.
- README: documented the byte-stability guarantee, the `ipynb_clean`
  `normalizeSource` exception, and the `clearOutputs: "auto"` execution-count
  behavior.

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
