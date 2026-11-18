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
- Every writing tool (`ipynb_edit`, `ipynb_cell_insert`, `ipynb_cell_delete`,
  `ipynb_cell_move`, `ipynb_clean`, `ipynb_outputs` clear, `ipynb_run`
  `save=true`) now reports `writeMode` and `writeModeReason` in its result
  metadata, and a fallback to a full-file rewrite also records a `json-patch`
  warning, so the degradation that issue #2 is about can never happen silently.
  Paths that write nothing report an undefined mode instead of claiming a
  patched write.
- An invalid `OPENCODE_IPYNB_OPTIONS` value is no longer silently ignored:
  `ipynb_doctor` reports the offending option and states that instance or
  default options are in effect.
- On Windows, a pyright `.cmd`/`.bat` shim whose command line contains shell
  metacharacters (`%`, `&`, `|`, `<`, `>`, `^`, quotes, CR/LF) is refused with
  an `unsafe-shell-command` diagnostics skip; the command is never handed to
  `cmd.exe`, where the quoting could not stop variable expansion or command
  splitting.
- Kernel and Python-runner kill failures are recorded as `cleanup` warnings
  instead of disappearing; a process that is already gone counts as success
  rather than as a warning. The kill helpers also refuse a reported pid of 1 so
  a lying helper can never broadcast a signal.
- Diagnostics sidecars are no longer rewritten when their content is unchanged,
  preserving their mtime and skipping the temp-file plus rename on repeated
  diagnostics of the same notebook.
- The silence guard, Lean proofs, and TLA+ models were hardened alongside: every
  deliberately silent site is inventoried in `docs/contributing.md`, and each
  spec ships with a dishonest twin plus vacuity probes (see that guide).

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
