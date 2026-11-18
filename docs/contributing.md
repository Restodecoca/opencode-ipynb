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
