# Architecture

`opencode-ipynb` is a V2-only OpenCode plugin for Jupyter notebooks. This
document is the map for maintenance work; the public usage guide is
[`../README.md`](../README.md).

## Lifecycle

`dist/index.js` (compiled from `src/index.ts` → `src/plugin.ts`) is the real
entrypoint resolved through the package `exports` map. `server.js` is the
compatibility fallback for a directory string without package resolution; it
re-exports `dist/index.js`.

`src/plugin.ts` is intentionally limited to lifecycle wiring:

1. Parse and normalize per-instance options (`src/plugin-options.ts`).
2. Register the 14 tools through `src/plugin-v2.ts` and
   `src/registrations.ts`.
3. Expose the RPC contract (`src/rpc.ts`): `document` and `changed`.
4. Install the `execute.after` hook.
5. Dispose hooks, RPC, tools, materialized LSP files, and scoped kernels.

Tool definitions and permission names live in `src/registrations.ts`; the
pure changed/no-op rules and result-text helpers live in
`src/notebook-hooks.ts`. Keep new hook logic there unless it needs lifecycle
state.

## Tools and permissions

Every tool is a `ToolDefinition` built with the internal `tool()` helper:
Zod args are converted to JSON Schema by `src/plugin-v2.ts`, and the tool runs
as a native OpenCode tool (`codemode: false`) so permission prompts attach to
the real call.

- Always-mutating tools declare `permission: "edit"`; mixed tools (`ipynb_outputs`, `ipynb_export`) assert `edit` only on their write branches.
- `ipynb_run` declares `"shell"`.
- `ipynb_lsp` declares `"lsp"`; its `materialize` branch additionally calls
  `ctx.permission.assert` with action `edit` for the sidecar path, and
  diagnostics asks `edit` for its temp file.
- Read-only tools (`ipynb_inspect`, `ipynb_read`, `ipynb_repro`) declare `read`;
  mixed tools assert `read`/`edit` per branch.
- Tool executors must call `rethrowPermissionDenied` in their catch blocks so a
  host rejection is not turned into normal tool content.

`src/plugin-v2.ts` maps `context.ask()` to the V2 permission domain and
`context.progress()` to metadata. Do not bypass it.

## Services and file safety

`src/services/` contains the Effect programs/services. `buildServices(ctx)` creates
per-call instances but shares module-level state where required:

- `PathService`: resolves paths and rejects traversal/symlink escapes.
- `NotebookFileService`: validates notebooks, serializes writes by **real
  path** (so symlink aliases share a lock), and pins the real path inside the
  worktree before reading/writing. Temp files are written with `wx` and renamed.
  The zod schemas are **validation-only**: reads return the raw `JSON.parse`
  object, and `src/utils/json-patch.ts` splices only the changed values into the
  stored text, so untouched bytes keep their layout (indentation, inline arrays,
  escapes, number literals, line endings). Do not write `parsed.data`;
  `z.object` rebuilds its output in declaration order and reflows the notebook
  (issue #2). Keep `test/unit/notebook-write-order.test.ts` and
  `test/unit/notebook-layout.test.ts` green.
- `NotebookEditService`, `NotebookExecutionService`, `NotebookReadService`,
  etc.: feature logic. `NotebookEditService.editCell` returns the in-memory
  notebook plus cell metadata and a `changed` flag internally; the tool layer
  exposes only a concise confirmation, never the source or a diff.
- `PythonService` instances are shared by option identity; kernel managers are
  scoped per plugin instance/context.

Path checks happen before work, and the file service resolves and verifies the
real path at use time (reads use the resolved path; writes target the resolved
file/parent). This removes the practical symlink-swap window for notebook I/O
without requiring a directory-fd API from Node. Residual path-based races are
documented as a limitation rather than claimed impossible. Bare `python` and
`pyright` names are resolved to absolute PATH entries before spawning; if
pyright is not found, the plugin fails closed instead of letting `cmd.exe`
search the project cwd. Relative `pythonPath`/`pyrightPath` values are rejected.

## LSP

The notebook is never sent to pyright as JSON. `src/lsp.ts` builds one virtual
Python document from code cells, and `toCellPosition`/`toVirtualPosition` map
positions both ways.

There are two consumers:

- `src/notebook-diagnostics.ts` runs the pyright CLI on the virtual document,
  filters errors, maps them to cells, and formats a wrapper-compatible block
  (the external plugin does not parse blocks from other plugins):
  `LSP errors detected in this file, please fix:` plus
  `<diagnostics file="...">ERROR [cell N, line L:C] ...</diagnostics>`.
  Lines/characters are 1-based in text; `metadata.notebookDiagnostics` keeps
  0-based cell-local positions (`cellIndex`, `line`, `character`, `endLine`,
  `endCharacter`), not an LSP `range` object. `ipynb_lsp operation=materialize` is the exception: its
  `metadata.cells` start/end lines are 1-based for the external `lsp` tool.
- `src/virtual-materialize.ts` writes the same virtual document (with IPython
  magics blanked) next to the notebook (inside the session directory) so an external `lsp` tool can
  answer hover/definition/references/symbols. The writer and cleanup reject
  symlinked ancestors/targets outside the session directory and replace
  symlinks safely. The `execute.after` hook refreshes an existing sidecar after
  edits.

`ipynb_lsp` diagnostics is a built-in fallback; materialization is deliberately
a two-step workflow (`ipynb_lsp` → external `lsp`) because OpenCode 2 has no
native LSP runtime and the external plugin only understands real files.

## Options and precedence

Options are validated once per plugin instance. `OPENCODE_IPYNB_PYTHON` wins
over `pythonPath`. `OPENCODE_IPYNB_OPTIONS` is the exception: it is a
process-global JSON override that replaces the whole options object. Other
options are per instance.
Warm kernels are grouped by plugin scope so two projects cannot share Python
state.

## Tests and packaging

- Unit tests cover services, path/symlink behavior, locks, diagnostics
  mapping, materialization safety, hooks, and the V2 adapter.
- `bun run build` removes `dist/` first, builds `index`, `lsp`, and `rpc`, and
  emits declarations. `server.js`, `dist/lsp.js`, and `dist/rpc.js` are part of
  the package contract.

## Known technical debt

- The services use Effect **4.0.6**, the same version OpenCode 2's plugin SDK
  uses. It is declared as a `peerDependency` so the host and the plugin share
  one Effect runtime; the build marks `effect` (and `effect/*`) external and
  never bundles it into `dist`. Keep the API usage
  on the Effect 4 surface (`Effect.gen`, `Cause.findErrorOption`,
  `Data.TaggedError`, etc.). Services are plain constructors returned to the
  tool layer; they are not registered in a `Context`/`Layer` because every
  tool call builds a context-scoped instance.
- Custom tool names cannot use OpenCode's native edit renderer; the plugin
  keeps edit results concise instead of shipping a renderer patch.
- Materialization is file-based, not LSP 3.17 notebook synchronization.

## Coordinate systems

- Tool arguments use a **0-based** `cellIndex` everywhere.
- Human-readable diagnostics print `cell <0-based index>, line L:C` with
  **1-based** line and character.
- The external `lsp` tool (`opencode-v2-lsp-support`) takes **1-based**
  line/character positions and converts them to LSP's 0-based positions.
- RPC `document` cells and `metadata.notebookDiagnostics` use **0-based**
  cell-local positions. `metadata.cells` from `materialize` is **1-based**
  because it is consumed by the external `lsp` tool.

These are boundary conventions, not conflicting values; conversions happen in
`src/lsp.ts` and `src/notebook-diagnostics.ts`.

## Known limitations

- Sidecar cleanup is scoped by the session directory. If two live plugin instances
  share one root, unloading one removes sidecars used by the other; re-run
  `ipynb_lsp operation=materialize` in that session.
- A crash can leave `opencode-ipynb-lsp-*.py` or `opencode-ipynb-diag-*.py`
  next to notebooks. They are gitignored and overwritten/reused on the next run.
- Materialization is limited to the session directory (the root used by the
  external `lsp` tool), not the whole worktree.
- A combined symlinked session root plus a notebook-file symlink that points
  into another subdirectory can produce a sidecar path outside the external
  LSP lexical root. Use a real session directory for that layout.
