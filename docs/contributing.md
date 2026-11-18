# Contributing

This project is a V2-only OpenCode plugin. Read
[`architecture.md`](./architecture.md) first; it explains the module boundaries
and the non-obvious file-safety/LSP rules.

## Setup

`bun run build` also needs Node (it clears `dist/` with `node -e`); CI installs it with `actions/setup-node`.

```bash
bun install
python3 -m venv .venv
.venv/bin/pip install -r python/requirements-test.txt
```

Pyright is only needed for `ipynb_lsp` diagnostics and the post-edit hook;
execution works without it. Install it with `uv tool install pyright` or
`npm i -g pyright`, or set `pyrightPath`.

The plugin never installs Python packages at runtime. Tests that only touch
the edit/read services do not need Jupyter; execution tests use the venv and
skip when it is unavailable.

## Commands

```bash
bun run typecheck
bun run typecheck:tests
PATH="$PWD/.venv/bin:$PATH" bun test
bun run build
npm pack --dry-run
```

- `bun run build` deletes `dist/` first; do not commit stale declaration files.
- `bun test` runs all unit/integration suites. Some execution tests are
  skipped when the venv is missing.
- Use the repository's Bun, not the Windows npm shim, when working from WSL.

## Adding a tool

1. Add `src/tools/<name>.ts` using the internal `tool()` helper.
2. Keep the executor thin: resolve options, call a service, format a concise
   result, and call `rethrowPermissionDenied` in the catch.
3. Register the definition in `src/registrations.ts` and add its permission
   name if it mutates or executes.
4. Update the hook sets in `src/notebook-hooks.ts` if the tool changes the
   notebook or can introduce Python errors.
5. Add unit tests for the service and the tool adapter. Update the README tool
   table and, when behavior changes, `docs/architecture.md`.
6. Run typecheck, tests, and build.

Tool results should be token-efficient. Do not echo the source, old/new
previews, or a diff unless a user-facing feature explicitly requires it.

## Options

Add fields to `PluginOptionsSchema` in `src/plugin-options.ts`, document them in
the README, and add defaults/precedence tests. Per-instance options belong in
`ToolContext.pluginOptions`; never write them to `process.env`. Environment
overrides are centralized: `OPENCODE_IPYNB_PYTHON` wins over the `pythonPath`
option, and `OPENCODE_IPYNB_OPTIONS` replaces the whole options object. Do not
read `process.env` for options inside tools/services.

## Permissions and paths

- Every write or execution must reach the host through `ctx.permission.assert`
  (via the tool context `ask`), and permission failures must propagate. Mixed
  tools may declare no tool-level permission, but every read/write branch asks
  the matching action. Permission resources include both the lexical and real
  path so a symlink alias cannot bypass a deny rule on the target.
- Never bypass `PathService` for notebook I/O; services also pin real paths
  before I/O. Sidecars and pyright temp files are the explicit exception: they
  have their own ancestor/target checks and must never touch notebooks directly.
- Keep per-file locking keyed by the resolved real path so symlink aliases
  serialize.
- When spawning subprocesses, kill the process group on timeout/abort and
  clean temp files in `finally`.
- Do not add a core/OpenCode patch for rendering. Notebook edits are plain
  tools; diagnostics use the LSP-compatible text block and metadata.

## LSP changes

- The virtual document is built by `src/lsp.ts`; keep position mapping
  zero-based internally and one-based in user-facing diagnostic text.
- Diagnostics must keep the wrapper shape used by `opencode-v2-lsp-support`:
  `LSP errors detected in ...` and `<diagnostics file="...">`. The inner lines
  add `ERROR [cell N, line L:C]`; the external plugin does not parse blocks
  produced by other plugins, so this is wrapper-compatible, not
  machine-compatible. Keep `metadata.notebookDiagnostics` with
  `cellIndex`/line/character. Do not claim native edit-renderer metadata for
  custom tools.
- Materialized files must stay inside the session directory (the external
  `lsp` tool's root) and must never follow a symlink outside it. They live
  next to the notebook (visible `opencode-ipynb-lsp-<hash>.py`, not a dotfile)
  so pyright resolves sibling imports; dotfiles are excluded by pyright.
  Identity is based on the notebook's real path, not its lexical alias. Keep
  the symlink tests in `test/unit/virtual-materialize.test.ts`, the sibling
  import regression in `test/integration/materialized-imports.test.ts`, and
  the path tests in `test/unit/path-service.test.ts`.
- `opencode-v2-lsp-support` is a separate plugin. Do not import its runtime;
  communicate through the materialized file + its `lsp` tool.
- The full navigation flow is documented in the README: `ipynb_lsp`
  `operation=materialize`, then `lsp` with 1-based positions from the cell map.

## Tests

- `test/unit/` covers services, path/symlink confinement, locks, diagnostics,
  hooks, options, and the V2 adapter.
- `test/integration/` contains execution/reproducibility fixtures and warm
  kernel tests.
- Prefer a failing regression test before a fix. Security tests must cover
  both the normal path and the symlink/escape path.
- Notebook writes must stay byte-stable: keep `test/unit/notebook-write-order.test.ts`
  and `test/unit/notebook-layout.test.ts` green. Services mutate the raw
  `JSON.parse` object, never `Schema.parse` output, and pass the `format` and
  `previousText` from `readWithText` to `writeAtomic`.
- When changing the hook, test the changed/no-op matrix (`changed: false`,
  output-only clears, failed tools, `save: false`).

## Release checklist

- `bun run typecheck && bun run typecheck:tests && bun test && bun run build`
- `npm pack --dry-run` includes `server.js`, `dist/index.js`, `dist/lsp.js`,
  `dist/rpc.js`, `python/ipynb_runner.py`, and `CHANGELOG.md`.
- Remove stale `dist/` artifacts before packing; the build script does this.
- Update README/docs for any option, permission, or tool change.
- Keep the package V1-free: no `@opencode-ai/plugin` imports and no V1
  `server()` export.

## Known debt

The services use Effect **4.0.6**, matching OpenCode 2's plugin SDK. It is a
`peerDependency`: the build marks `effect` (and `effect/*`) external, so the
host and the plugin share one runtime. Keep new code on the Effect 4 API
(`Effect.gen`, `Cause.findErrorOption`, `Data.TaggedError`, etc.). Services are
plain constructors built per tool context; do not add unused `Context.Service`
tags.

Effect 4 conventions used here:

- `Effect.gen` for inline composition; reusable effect functions use
  `Effect.fnUntraced` (see `KernelManager.execute`). `Effect.all` with a
  concurrency bound for independent work.
- `Effect.tryPromise` for fallible async work and `Effect.promise` only for
  infallible async work.
- Keep typed errors honest: do not use `mapError((e) => e as X)` casts. Add the
  error to the service union instead.
- Use `Effect.Semaphore` for per-file locks instead of running an Effect from
  inside another Effect.
- At the tool boundary use `Effect.runPromiseExit` +
  `Cause.findErrorOption`/`Cause.squash` so host permission errors propagate.
- Prefer `Data.TaggedError` for domain errors and keep `_tag` checks out of
  business logic.

## Review protocol

Every review, human or agent, must produce evidence rather than confidence.

1. **Consult the installed dependency source first.** `node_modules/effect`,
   `node_modules/zod`, `node_modules/@types/bun`, `node_modules/@opencode/plugin`
   and `node_modules/@opencode/schema`, plus `.venv/lib/*/site-packages/nbformat`
   for notebook semantics. Never judge an API from memory.
2. **Use the language server.** `documentSymbol` to map a changed module,
   `goToDefinition` and `hover` for anything not local, and `findReferences`
   before changing a function, type, or shared contract. Report which symbols
   and references were inspected; claim no navigation that did not happen.
3. **Model the state machines.** `specs/` holds TLA+ models; `tlc` must agree.
   Concurrency, locking, and revision checks belong there, not in prose.
4. **Prove the pure properties.** `proofs/` holds the Lean 4 development;
   `lake build` must succeed. Shape and round-trip invariants belong there.
5. **Test both ways.** Run the suite, and run the opposite mutation: if a fix
   cannot be reverted to make a test fail, the test proves nothing.
6. **Never accept silence.** A swallowed failure is a defect. Record it through
   `src/utils/warnings.ts` or surface it in the tool result; if a best-effort
   step is genuinely expected to fail, say why in the report rather than
   discarding it.
7. **No explanatory comments in `src/`.** Intent belongs in the public types,
   the tests, and these docs.
8. **Report the config.** State the Bun/Node/Python versions and the exact
   commands used, so the result can be reproduced.

`./scripts-verify.sh` runs the Lean build and every TLA+ model. `bun run
scripts/bench-writes.ts` asserts that write cost stays linear in the notebook
size; a superlinear result fails the build. CI runs both.

### Deliberately silent sites

These failures stay unreported on purpose; every other swallowed failure
must reach a `WarningSink`. `test/unit/silence-allowlist.test.ts` scans the
whole source — including multi-line catch blocks, which a line-based scan
cannot see — and fails unless each silent site appears with its exact count:

- Chaining an existing lock (`await previous.catch(() => {})` in
  `KernelManager` and `notebook-diagnostics`) — the previous holder already
  ran; there is no intent to defeat.
- Closing a read-only file descriptor we are done with
  (`NotebookFileService`) — no data can be lost and there is no remedy.
- The host's `context.progress()` (`plugin-v2`) — a refused progress update
  is not a plugin failure.
- Existence and executability probes (`PythonService` ×3, the PATH scan in
  `notebook-diagnostics`, the PATH scan in `plugin-options`) — a candidate
  that is missing or not executable is the normal negative result of a
  probe, not a failure worth reporting.
- Realpath fallbacks (`diagnosticHash` in `notebook-diagnostics`,
  `virtual-materialize`) — when realpath fails, the caller falls back to the
  lexical path, which is its documented behavior.

Also deliberate, though not empty-catch sites the scan can count:

- `loadNotebookDocument` dropping a failed `resolvePythonPath` — the hook
  path has no user to tell and interpreter auto-discovery continues; the
  tool paths surface a bad `pythonPath` loudly through `pythonPathError`.

Everything else must reach a `WarningSink`, and the cases below announce
themselves explicitly rather than staying silent:

- A failed patch falling back to a full rewrite records a `json-patch`
  warning and the tool reports `writeMode`/`writeModeReason` metadata.
- Kill-path failures are recorded through the `cleanup` warning source; a
  kill of an already-dead process (ESRCH) is success, not a failure.
- An invalid `OPENCODE_IPYNB_OPTIONS` is surfaced through the services'
  `envOptionsError` and a warning section in `ipynb_doctor`.
