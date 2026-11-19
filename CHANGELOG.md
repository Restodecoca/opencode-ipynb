# Changelog

## 3.0.0

Byte-stable writes, a hardened tool boundary, and measured performance. The one
breaking change for existing callers is `ipynb_export`'s output extension; it is
first so it is easy to find.

### Breaking

- `ipynb_export` refuses an `outputPath` that does not end in `.md`, `.markdown`,
  `.py`, `.txt` or `.rst` (after the win32 trailing dot/space normalization).
  Previously any path that was not a `.ipynb` was written, which let a mistaken
  prompt overwrite `.env`, `package.json` or a key file; the tool description
  states the restriction.

### Correctness

- Writes are byte-stable (issue #2): the zod schemas validate only, and the raw
  `JSON.parse` object is passed through unchanged (`applyNotebookDefaults` is
  pure and returns a clone), so no write re-emits the notebook in
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
- `ipynb_run save=true` gives every cell its own share of `maxOutputChars`
  instead of draining one pool: later cells used to be persisted with empty
  `stdout` over real output. Raw MIME bundles are persisted verbatim, so a
  `text/html` or `image/png` display data survives a save instead of being
  replaced by a `text/plain` summary.
- Defaulted keys (`metadata`, cell `outputs`) are inserted in sorted position
  when the object's keys are already sorted, and appended otherwise, so an
  existing key order is never reordered to make room for a default.
- A code cell that omits `execution_count` is accepted (nbformat treats the field
  as optional) and a rewrite keeps the key absent instead of injecting it.
- Union validation failures name the offending field and the accepted values
  (`cells.0.cell_type: expected "markdown"`) instead of collapsing to
  `Invalid input`.
- Deeply nested values are refused with the depth limit named (512) instead of
  surfacing a `Maximum call stack size exceeded`.
- A custom JSON Schema is generated with `additionalProperties: false` and the
  `ipynb_read` / `ipynb_outputs` argument rules, so a misspelled argument or a
  call the tool would reject is refused before it runs. A misspelled
  `clear_outputs` used to be dropped and wiped outputs.
- `truncateMarkdown` no longer emits a lone surrogate when a budget splits an
  astral character.
- A value JSON cannot represent (`undefined`, `BigInt`, a cycle) is refused with
  an actionable message instead of being dropped and reported as a successful
  write.

### Data safety and atomicity

- A notebook whose bytes are not valid UTF-8, or that starts with a BOM, is
  rejected at read time instead of being decoded with replacement characters
  and silently rewritten later.
- A tool call cancelled during the permission prompt writes nothing; a retried
  insert or delete cannot apply twice.
- A write that another process replaces immediately after the rename fails with
  a concurrent-replacement error instead of reporting success for a change that
  is no longer in the file, and a file deleted right after the rename is
  reported instead of silently succeeding.
- A write refused by a parent-directory swap no longer leaves the full new
  notebook content behind as a hidden `.tmp`: cleanup tracks wherever the temp
  moved and sweeps the unique name beside the original directory.
- The notebook write and the export are fsynced (content and directory, on
  POSIX), so a returned success survives a crash.
- The parent directory is re-resolved and the containment re-checked immediately
  before the rename, for notebook writes and for the LSP sidecar.
- An unreadable target is refused by the pre-rename revision re-read instead of
  warning and writing anyway.
- Windows path confinement no longer accepts a drive root, a path on another
  drive, or an outside path whose ancestor is a drive root; the regression was
  found on a real Windows host and CI now runs the suite there.

### Performance

- `isMultiline` no longer scans to the end of the document per node, which made
  compact notebooks quadratic: a 256k-key compact object fell from 6.8 s to
  0.76 s.
- `sanitizeTerminal` skips the whole examined window after an unterminated OSC
  introducer: 40 MB of `ESC ]` noise fell from 4.1 s to 0.10 s.
- `formatOutputs` bounds a JSON dict before serializing it: 1000 sections of
  100k keys fell from 5.6 s to 7 ms and is now constant in the section count.
- The patcher builds its node tree from offsets and parses the value once
  natively; array nodes store item spans and materialize only the changed ones.
  A one-cell edit in a 17 MB / 64k-cell notebook fell from 1048 ms to roughly
  400-550 ms and the patch allocation from ~240 MB to ~43 MB.
- Non-ASCII `ensureAscii` escaping uses a lookup table instead of per-character
  concatenation: a 10 MB string fell from 2094 ms / +1992 MB to 485 ms / +282 MB.
- `realpathWithRetry` stops retrying a genuinely absent path: a missing path
  fell from 8.9 ms to 0.62 ms, and a new notebook several directories deep is
  created in milliseconds.
- `scripts/bench-alloc.ts` pins the per-patch allocation with a fixed workload
  (42-44 MB against a 60 MB ceiling and 161-171 MB for the previous tree);
  `scripts/bench-writes.ts` asserts time and RSS budgets for a compact notebook,
  a large per-cell output, non-ASCII escaping, an object-heavy patch and a
  17 MB edit.

### Kernel and Python helper

- A warm-kernel response must echo a per-request nonce: a notebook cell shares
  the helper's stdout, so `os.write(1, '{"id":N,...}')` could settle another
  request (and `save=true` persisted the forged output). Helpers that do not
  advertise the nonce keep working.
- A kernel that dies under nbclient is torn down and the next request starts a
  fresh kernel instead of failing until an explicit restart.
- An aborted or timed-out request no longer kills the shared kernel for other
  in-flight requests.
- A queued `shutdown` preempts a running cell instead of waiting for it.
- The helper validates `timeoutMs` and `maxOutputChars` and returns a structured
  error instead of a traceback and exit 1; a missing `pip` degrades the `env`
  report to an empty package list instead of failing it; a serve request that
  names a different notebook is refused instead of silently running the init
  notebook.
- The helper exits when its parent disappears, so a plugin crash no longer
  leaves an orphaned helper and kernel running until the cell ends.
- `MAX_HELPER_STDOUT_BYTES` is compared against UTF-8 bytes, and an aborted
  oversized line clears its request timer instead of killing the next request.

### Tooling, proofs and specs

- The silence guard also matches `.catch(() => identifier)` forms; every
  deliberately silent site is inventoried in `docs/contributing.md`.
- `scripts-vacuity.sh` ships the non-vacuity probes the guide promises: it
  builds a temporary inverse invariant for all 17 checked states and fails when
  TLC does not violate it. `scripts-verify.sh` runs it.
- Lean: sortedness is modelled over the UTF-16 unit order the shipped comparator
  uses, `MarkdownSafe` records the clamped case and the well-formedness property,
  and `NotebookDefaults` states key/value stability rather than only
  "present implies noop".
- TLA+: `KernelWarningRing` gained a dishonest twin, and the scope each model
  actually covers (win32 replace, `DeliveredBounded`) is stated in the module.
- `prepack` now verifies the packed file set (`server.js`,
  `python/ipynb_runner.py`, docs) and greps `dist/index.js` for strings from the
  current sources, so a stale or incomplete package cannot ship.
- CI: the test job retries up to three times, annotates every failing test and
  uploads every attempt's log; Windows and macOS jobs run the suite.
- The LSP materialized sidecar is not rewritten when its content is unchanged,
  preserving its mtime. The diagnostics temp file is still rewritten per call.

### Documentation

- `README`, `CHANGELOG` and `docs/` statements were checked against measured
  behavior: the byte-stability claims, the defaulted-key insertion, the sidecar
  no-rewrite scope, and the inode check's actual reach.

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
