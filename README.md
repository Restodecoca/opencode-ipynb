# opencode-ipynb

A community [OpenCode](https://opencode.ai) plugin that adds robust support for Jupyter Notebook (`.ipynb`) files: inspect, read, edit, run, outputs, clean, export, reproducibility reports, and warm Python kernels.

> **OpenCode 2.x only.** The plugin implements the V2 plugin API and does not load on OpenCode 1.x.

The plugin is **opt-in**, distributed via npm, and does not modify the OpenCode core. It exposes fourteen agent tools that operate on `.ipynb` files with explicit permissions, granular context control, and a strongly-typed [Effect 4.0.6](https://effect.website) runtime internally, matching OpenCode 2.

> Repository: https://github.com/Restodecoca/opencode-ipynb
> Issues: https://github.com/Restodecoca/opencode-ipynb/issues

## Why a plugin and not core

- Notebooks are large, binary-like artifacts. Dumping them into the agent context burns tokens.
- Reading outputs and editing cells are high-trust actions that are gated by the host permission system.
- The execution flow needs a Python runtime, which is not something every OpenCode user wants installed.
- A plugin lets the community iterate on these workflows without forcing changes on the OpenCode core.

## Installation

OpenCode 2.x loads plugins from the `plugins` key. Until the V2 line (`2.0.0`) is published, point OpenCode at a checkout directory:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/absolute/path/to/opencode-ipynb"]
}
```

The npm `latest` tag still points at the V1 `0.1.2` package, which does **not** load in OpenCode 2. After the V2 package is published, the versioned form is:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-ipynb@2.0.0"]
}
```

`opencode.example.jsonc` is a machine-independent local example.

Or run directly from this repo:

```bash
git clone https://github.com/Restodecoca/opencode-ipynb
cd opencode-ipynb
bun install
bun run build   # requires Bun and Node (Node clears dist/)
```

Then add the **absolute path** to this checkout to the `plugins` array in your `opencode.json` (package-name resolution only works after the V2 package is published).

## Tools

| Tool                 | Purpose |
| -------------------- | ------- |
| `ipynb_inspect`      | Compact summary: kernel/language metadata, cell table, output stats, execution-order warnings, optional missing-package checks. |
| `ipynb_read`         | Granular read of one cell or a range, with optional outputs/errors/metadata/images and truncation limits. |
| `ipynb_edit`         | Safe per-cell source edit with a concise confirmation, output clearing policy, permission gate, and per-file lock. |
| `ipynb_cell_insert`  | Insert a code/markdown/raw cell at a target index, or append when the index is omitted. |
| `ipynb_cell_delete`  | Delete one cell by index and return a preview of the deleted source. |
| `ipynb_cell_move`    | Move one cell to a new index. |
| `ipynb_run`          | Execute one cell, a range, from a cell, or a full notebook via the Python helper. Supports save-to-notebook and optional warm kernels. |
| `ipynb_outputs`      | List / read / read_error / clear_cell / clear_all outputs with pagination and permission gates for writes. |
| `ipynb_clean`        | Strip outputs, execution counts, widget state, large images, and normalize `source` arrays for Git-friendly diffs. |
| `ipynb_export`       | Export to Markdown, Python, or summary; optionally write to disk after permission. Files are written with full text outputs (images are represented by notices); the tool output is capped by `maxExportChars`. |
| `ipynb_doctor`       | Diagnose Python, helper discovery, and required Jupyter dependencies. |
| `ipynb_repro`        | Reproducibility report: kernel/env info, `pip freeze`, filesystem reads, random seeds, non-determinism, missing packages. |
| `ipynb_kernel`       | Inspect/restart/shutdown warm kernels when the `warmKernel` plugin option is enabled. `restart` stops the current kernel; the next run starts a new one. |
| `ipynb_lsp`          | Run on-demand Python diagnostics, or materialize the virtual `.py` for per-cell LSP navigation. |

### Examples

Inspect a notebook before doing anything else:

```text
ipynb_inspect({ filePath: "notebooks/eda.ipynb" })
```

Read a single cell:

```text
ipynb_read({ filePath: "notebooks/eda.ipynb", cellIndex: 7 })
```

Read a range including outputs:

```text
ipynb_read({
  filePath: "notebooks/eda.ipynb",
  start: 0,
  end: 5,
  includeOutputs: true,
  maxOutputChars: 4000
})
```

Edit one cell, clear outputs automatically:

```text
ipynb_edit({
  filePath: "notebooks/eda.ipynb",
  cellIndex: 7,
  source: "import pandas as pd\ndf = pd.read_csv('data.csv')\ndf.head()"
})
```

Clean for a clean diff before commit:

```text
ipynb_clean({ filePath: "notebooks/eda.ipynb" })
```

Export to a Python script next to the notebook:

```text
ipynb_export({
  filePath: "notebooks/eda.ipynb",
  format: "python",
  outputPath: "notebooks/eda.py"
})
```

## Edit results and diagnostics

`ipynb_edit` returns a concise confirmation (cell, file, type, and whether outputs were cleared) instead of echoing the old/new source or a diff. The model already has the source it sent, so the extra text only spends tokens.

After code-changing tools, the plugin runs pyright on the notebook's virtual Python document for **Python notebooks only** and appends errors in the same block shape used by [`opencode-v2-lsp-support`](https://github.com/christensenjairus/opencode-v2-lsp-support):

```text
LSP errors detected in this file, please fix:
<diagnostics file="/absolute/path/notebook.ipynb">
ERROR [cell 0, line 1:10] Type "Literal['no']" is not assignable to declared type "int"
</diagnostics>
```

The cell-mapped errors are also available as `metadata.notebookDiagnostics`; `metadata.diagnostics` is not emitted for custom tools because OpenCode 2 only feeds that field to its native edit renderer. `ipynb_lsp` runs the same check on demand and reports whether it was skipped (timeout, missing pyright, invalid output, not-analyzed, temp-unwritable, aborted, unsupported-language) instead of claiming a clean result.

## Safety and permissions

- Every write (`ipynb_edit`, `ipynb_cell_insert`, `ipynb_cell_delete`, `ipynb_cell_move`, `ipynb_clean`, `ipynb_outputs clear_*`, `ipynb_export --outputPath`, and `ipynb_lsp operation=materialize` for its sidecar) calls `ctx.permission.assert` before touching the disk, and every execution (`ipynb_run`) asks with rich metadata: file path, mode (`cell` / `range` / `all` / `from`), cell range, save flag, working directory, timeout. When `save=true`, a second `edit` assert covers the notebook write.
- Permission requests use V2 action names: writes use `edit`, reads use `read`, and execution uses `shell`. Configure them with the ordered `permissions` array, for example `[{ "action": "edit", "resource": "*", "effect": "ask" }, { "action": "shell", "resource": "*", "effect": "ask" }, { "action": "lsp", "resource": "*", "effect": "ask" }]`. **Rules are evaluated in order and the last matching rule wins**: put a specific `deny` after a broad `allow`, otherwise the allow overrides it. The plugin sends absolute, real, and session-relative resource paths so relative rules such as `secrets/*` also apply. For example:

```json
"permissions": [
  { "action": "read", "resource": "*", "effect": "allow" },
  { "action": "read", "resource": "secrets/*", "effect": "deny" },
  { "action": "edit", "resource": "*", "effect": "allow" },
  { "action": "edit", "resource": "secrets/*", "effect": "deny" },
  { "action": "shell", "resource": "*", "effect": "ask" },
  { "action": "lsp", "resource": "*", "effect": "ask" }
]
```

Note that a tool-level `edit: deny` also removes tools that declare `options.permission: "edit"` from the model catalog; mixed tools remain visible and fail when their write branch asserts `edit`.
- Tools that always mutate (`ipynb_edit`, `ipynb_cell_insert`, `ipynb_cell_delete`, `ipynb_cell_move`, `ipynb_clean`) declare `options.permission: "edit"`, and `ipynb_run` declares `"shell"`. `ipynb_lsp` declares `"lsp"`; diagnostics asks for `lsp`/`read` on the notebook and `edit` on its temporary analysis file; materialize asks for `read`/`lsp` on the notebook and `edit` on the sidecar path. Read-only tools (`ipynb_inspect`, `ipynb_read`, `ipynb_repro`) declare `"read"` and also assert `read` on the notebook path. When they need Python, they assert `shell` before spawning it: `ipynb_repro` always does, and `ipynb_inspect` only when `checkMissingPackages=true`. This ordering means a denied `shell` action prevents the subprocess entirely. `ipynb_doctor` also asserts `shell` for the interpreter before probing it. Mixed read/write tools (`ipynb_outputs`, `ipynb_export`) do not declare a tool-level permission; their read branches assert `read` and their writes assert `edit`. `ipynb_doctor` declares no permission action. `ipynb_kernel` declares no tool-level action, but `restart`/`shutdown` assert `shell` on the kernel's notebook path before stopping it.
- `PathService` rejects paths that resolve outside of the OpenCode worktree, and `NotebookFileService` pins the resolved real path inside the worktree before reading or writing. Symlink aliases share a lock and writes update the real target rather than replacing the link. The lock manager keys by real path and serializes per-file writes to prevent accidental corruption.
- The Python execution helper is an opt-in, isolated subprocess; it does not auto-install Jupyter. The user installs `python/requirements.txt` only when they want real execution.

## Context control

Notebooks can be enormous. By default the plugin never dumps a full notebook into context:

- `ipynb_inspect` returns a table with the first line of every cell, plus aggregate counts. It never includes the full source.
- `ipynb_read` defaults to **not** including outputs. Set `includeOutputs: true` to opt in. Images/base64 are omitted by default; set `includeImages: true` to receive them as file attachments (the text block still only contains a size notice).
- `maxSourceChars` (default 12 000) and `maxOutputChars` (default 6 000) cap per-cell source/output; tracebacks have their own 8 000-character cap.
- Notebook reads are limited to 50 MB and `ipynb_read` ranges to 500 cells; use `ipynb_inspect` for a compact summary of very large notebooks.
- `ipynb_run save=true` reports `saved:false` when no code cell was actually written (for example a markdown-only target).
- Error tracebacks are capped internally at 8 000 characters.
- Truncation appends `... (truncated, use maxXxx to increase)`; with extremely small budgets the hint itself may exceed the requested maximum, but original content is never included.

Most limits live in `src/utils/limits.ts`; the traceback cap is fixed in `src/format/outputs.ts`.

## LSP integration

The plugin does not ship or require a language server, but it exposes a stable, provider-agnostic bridge so an OpenCode LSP or a third-party plugin can consume notebook edits.

The compatibility model is the **file-based virtual document** used by jupyter-lsp, jedi-language-server, Ruff, and Pyrefly: code cells are concatenated into one virtual source file, and positions are mapped back to `(cellIndex, line, character)`. Clients that implement LSP 3.17 `notebookDocument` synchronization can build on the per-cell `text`/`uri` fields; they still need to supply notebook type, versions, and stable cell identity themselves.

- `opencode-ipynb/lsp` exports `buildNotebookVirtualDocument()` plus `toCellPosition()` / `toVirtualPosition()` / `makePositionMapper()`. The document also carries `languageId`, `fileExtension`, `kernelName`, and the configured `pythonPath` so a client can select the right environment (including a conda or uv environment) before starting pyright/pylsp/jedi.
- The `opencode-ipynb` RPC contract (`opencode-ipynb/rpc`) exposes:
  - `document({ filePath })` → `{ filePath, notebookUri, languageId, fileExtension, kernelName, pythonPath, text, sanitizedText, cells }`
  - `changed({ filePath })` → emitted after tools that modify the notebook (`ipynb_edit`, cell insert/delete/move, `ipynb_clean`, output clearing, and `ipynb_run` when `save` is not `false`).

The RPC document is client-facing and is not routed through model tool permissions. A third-party server plugin can subscribe to `changed`, call `document`, and feed `sanitizedText` to pyright/jedi (`text` is the raw concatenation; `sanitizedText` blanks IPython magics and `?`/`!!` help syntax). The per-cell `text`/`uri` fields are a starting point for an LSP 3.17 notebook client, which remains responsible for notebook/cell versions and stable cell identity.

The plugin also ships a small built-in consumer so diagnostics are useful without a third-party plugin:

- After code-changing tools (`ipynb_edit`, cell insert/delete/move), it runs pyright on the virtual document for Python notebooks and appends mapped errors to the tool result in the same wrapper shape used by `opencode-v2-lsp-support` (`LSP errors detected ... <diagnostics file=...>`). The inner error lines add `[cell N, line L:C]`; `opencode-v2-lsp-support` does not parse blocks produced by other plugins.
- `ipynb_lsp` runs the same check on demand.
- Non-Python notebooks are left alone; missing pyright is skipped silently, while timeout/invalid-output is reported explicitly.
- Set `lspDiagnostics: false` to disable the automatic pass, or `pyrightPath` to point at a specific executable. Missing pyright is ignored; the notebook tools keep working.

### Per-cell navigation with `opencode-v2-lsp-support`

OpenCode 2 has no native LSP runtime; the [`opencode-v2-lsp-support`](https://github.com/christensenjairus/opencode-v2-lsp-support) plugin provides the `lsp` tool and its servers. To use hover, go-to-definition, find-references, or document symbols on a notebook cell, materialize the notebook's virtual document:

```text
ipynb_lsp({ filePath: "notebooks/eda.ipynb", operation: "materialize" })
```

It writes a small, visible `.py` sidecar **next to the notebook** (still inside the session directory, which is the root used by `opencode-v2-lsp-support`) and returns the path plus a cell-to-line map. Writing it beside the notebook is what lets pyright resolve sibling imports such as `notebooks/helpers.py`:

```text
Virtual Python document: /project/notebooks/opencode-ipynb-lsp-4f2c1a9b7d3e5f60.py
Call the lsp tool from opencode-v2-lsp-support with this path. Positions are 1-based.
Cell map:
- cell 0 (code): lines 1-8
- cell 1 (code): lines 9-12
```

Then call the LSP plugin's `lsp` tool with that path and a 1-based line/character from the map:

```text
lsp({ operation: "hover", path: "/project/notebooks/opencode-ipynb-lsp-4f2c1a9b7d3e5f60.py", line: 10, character: 12 })
lsp({ operation: "goToDefinition", path: "...", line: 10, character: 12 })
```

The result is a normal LSP location (for the virtual file, e.g. `opencode-ipynb-lsp-4f2c1a9b7d3e5f60.py:10:5`); use the cell map to report it as `[cell 1, line 2:5]`. Coordinate contract: tool `cellIndex` is 0-based; the external `lsp` tool's line/character are 1-based; `metadata.notebookDiagnostics` and RPC cells are 0-based LSP positions; the `metadata.cells` start/end lines from `materialize` are 1-based for the external tool (cell indices remain 0-based). The same works for `findReferences`, `documentSymbol`, and the other operations supported by that plugin. The cell map contains code cells only. Materialized files are refreshed automatically after plugin notebook edits (`ipynb_*`); edits made outside the plugin require re-running `materialize`. `ipynb_edit` changes that add or remove source lines, and `ipynb_cell_insert`, `ipynb_cell_delete`, or `ipynb_cell_move`, shift code-cell line numbers. Re-run `materialize` after any such edit if you need an updated cell map. Sidecars are removed when the plugin unloads, so run `materialize` and the `lsp` calls in the same session. Add `opencode-ipynb-lsp-*.py` to `.gitignore` (this repository already does).

```ts
import { NotebookRpc } from "opencode-ipynb/rpc"

export default {
  id: "my-notebook-lsp",
  async setup(ctx: any) {
    const notebook = ctx.rpc(NotebookRpc)
    notebook.events.on("changed", async (event) => {
      const doc = await notebook.document({ filePath: event.data.filePath })
      // Analyze doc.sanitizedText as a virtual .py file, then map diagnostics back with
      // the exported position helpers; or use doc.cells with notebook sync.
    })
  }
}
```

Conda itself does not provide a notebook language server. `conda-lsp`/YAML language servers target conda/YAML files, not Python cells. Use conda or uv to select the interpreter (`pythonPath`/`kernelName`) and a Python language server for the code. Do not add `.ipynb` to pyright's `extensions`: pyright must receive the virtual `.py` text, not the notebook JSON.

Known limitations of the virtual-document model: the whole notebook is re-analyzed when any cell changes; Python-bodied cell magics (`%%time`, `%%capture`) keep their body, while shell/non-Python cell magics are blanked; shell assignment forms (`x = !ls`) are not analyzed; top-level `await` and kernel-only state are not understood by static servers; diagnostics may differ from runtime behavior.

## Python execution

The plugin **never installs Python dependencies automatically**. Running `ipynb_run` is opt-in and requires a Python environment with `nbformat`, `nbclient`, `jupyter_client`, and `ipykernel`. The plugin only detects what is available and tells you how to fix what is missing.

### Preferred: `uv`

```bash
uv pip install pip nbformat nbclient jupyter_client ipykernel
python -m ipykernel install --user
```

### Alternative: pip in a venv

```bash
python -m venv .venv
source .venv/bin/activate            # Windows: .venv\Scripts\activate
pip install nbformat nbclient jupyter_client ipykernel
python -m ipykernel install --user
```

### Alternative: conda

```bash
conda install -c conda-forge nbformat nbclient jupyter_client ipykernel
```

### Pointing the plugin at a specific Python

OpenCode may use a different Python interpreter than the one in your terminal. The environment variable takes precedence over plugin options; the PATH fallback is used only when neither sets an interpreter. The sections below are ordered from configuration to fallback:

1. Plugin options (in `opencode.json`):

   ```json
   {
     "plugins": [
       {
         "package": "/absolute/path/to/opencode-ipynb",
         "options": {
           "pythonPath": "/home/gabriel/.venv/bin/python",
           "helperRelativePath": "python/ipynb_runner.py",
           "preferUv": true,
           "defaultTimeoutMs": 120000,
           "defaultMaxOutputChars": 6000,
           "warmKernel": false,
           "allowOutsideWorktree": false
         }
       }
     ]
   }
   ```

   - `pythonPath` (string): absolute path to a Python interpreter, or a bare name resolved through `PATH`. Path-like relative values are rejected so the permission resource and the spawned executable cannot diverge.
   - `helperRelativePath` (string, default `python/ipynb_runner.py`): helper path relative to the plugin package, or an absolute path. It is deliberately never resolved from the project cwd, so a repository cannot shadow the shipped helper.
   - `preferUv` (boolean, default `true`): the doctor and the Python service prefer `uv pip install` over `pip install` in their suggestions.
   - `defaultTimeoutMs` (number, default `120000`): timeout in milliseconds for `ipynb_run`.
   - `defaultMaxOutputChars` (number, default `6000`): fallback for `ipynb_read`, `ipynb_outputs read`, and `ipynb_run` when the user does not pass `maxOutputChars`.
   - `warmKernel` (boolean, default `false`): keep a long-lived Python subprocess per notebook path for faster repeated `ipynb_run mode=all` / `mode=cell` calls. Manage it with `ipynb_kernel`.
   - `lspDiagnostics` (boolean, default `true`): after `ipynb_edit`, `ipynb_cell_insert`, `ipynb_cell_delete`, or `ipynb_cell_move`, run pyright on the notebook's virtual Python document and append errors to the tool result. Set `false` to disable the extra pass.
   - `pyrightPath` (string, default `pyright`): pyright executable for the diagnostics pass. Use an absolute path if pyright is not on `PATH`.
   - `diagnosticsTimeoutMs` (number, default `15000`): timeout for the diagnostics pass.
   - `allowOutsideWorktree` (boolean, default `false`): power-user escape hatch — when `true`, the plugin will read and write `.ipynb` files outside the OpenCode worktree. Leave at `false` unless you know why you need it.

2. Environment variables (the shell wins over plugin options):

   ```bash
   OPENCODE_IPYNB_PYTHON=C:/Users/Gabriel/miniconda3/envs/data/python.exe opencode
   OPENCODE_IPYNB_OPTIONS='{"pythonPath":"/usr/bin/python3","defaultMaxOutputChars":4000}' opencode
   ```

   `OPENCODE_IPYNB_PYTHON` overrides the plugin `pythonPath` option only. `OPENCODE_IPYNB_OPTIONS` overrides the whole plugin options object (a JSON object validated by the same schema). Both are process-level overrides, so prefer the `plugins` object form when you only want to configure one project.

3. PATH fallback: the plugin uses the first `python` if present, otherwise `python3`. It does not retry after a broken interpreter, so every spawned interpreter is covered by the shell permission request. Path-like `pythonPath` values must be absolute; bare names are resolved through PATH.

### Diagnose first

If anything goes wrong, run:

```text
ipynb_doctor
```

It reports the selected interpreter, every Jupyter dependency (`[ok]` / `[missing]`), where the helper script was found, and a copy-pasteable install command. It never installs anything.

## Known limitations

- Python execution depends on the user's local Python/Jupyter environment. The plugin diagnoses missing packages but never installs them.
- Warm kernels are intentionally limited to `ipynb_run mode=all` and `mode=cell`; `range`, `from`, and `env` use one-shot helper processes.
- Large notebooks and rich outputs are truncated in tool responses to protect context. When `ipynb_run save=true` completes successfully, the executed code cells write their nbformat outputs to disk; a failed run returns its error without writing partial results.
- `allowOutsideWorktree` is a power-user escape hatch. Keep it disabled unless you explicitly need cross-worktree notebook access. Enabling it also bypasses the host's `external_directory` deny rules for plugin tools; restrict the plugin tools themselves if that matters.
- `ipynb_run` `workingDirectory` controls the one-shot helper process, not the notebook cell cwd; nbclient always runs cells in the notebook directory. Warm kernels reject any non-undefined `workingDirectory`.

## Examples

Three small, runnable notebooks live under `test/integration/` and double
as both documentation and a smoke test for the plugin's read / run /
export loop:

- [`test/integration/classification/`](./test/integration/classification/) — `LogisticRegression` on `sklearn.datasets.load_iris` (7 cells, no CSV needed).
- [`test/integration/timeseries/`](./test/integration/timeseries/) — `numpy` moving average over a noisy sine wave (5 cells, stdlib-friendly).
- [`test/integration/scraping/`](./test/integration/scraping/) — `urllib.request` + `html.parser` fetch of `https://example.com/` (4 cells, stdlib only, graceful `try/except` on network failure).

Each one ships with `outputs: []` and a matching `README.md` that lists
the exact `ipynb_inspect` / `ipynb_read` / `ipynb_run` calls plus the
expected output.

## Release

The published npm tarball contains only the runtime: `dist/`, `server.js`, `python/ipynb_runner.py`, `python/requirements.txt`, `README.md`, `CHANGELOG.md`, and `LICENSE`. Internal developer docs, helper dev scripts, and `.github/` workflows are excluded by the `files` whitelist in `package.json` (with `.npmignore` as a second guard). `AGENTS.md` and `TODO.md` are local and gitignored; `docs/` is tracked for contributors and is not shipped to npm. Contributors track their work through GitHub Issues and Discussions.

Cut a release by tagging the commit and pushing the tag, then publish it on GitHub — the workflow runs only on the `published` release event:

```bash
git tag vX.Y.Z && git push --tags
```

Then create a GitHub release at https://github.com/Restodecoca/opencode-ipynb/releases/new pointing at `vX.Y.Z`. The CI runs `bun run typecheck`, `bun run typecheck:tests`, `bun test`, and `bun run build` before `npm publish --provenance --access public`. The repository must have a single secret configured: `NPM_TOKEN` (an npm automation token with publish rights for the package name in `package.json`).

Before publishing, run a local package check:

```bash
bun run typecheck
bun run typecheck:tests
bun test
bun run test:coverage
bun run build
npm pack --dry-run
```

The `2.0.0` release is the V2-only line. The npm `latest` tag currently points at the V1 `0.1.2` package; publish `2.0.0` before advertising the package name as a V2 install. If you publish under a scope instead, update `package.json`, the install snippet, and this release tag convention together.

## Effect LSP setup (for development)

This project uses the [Effect Language Service](https://effect.website/docs/getting-started/devtools/) to surface Effect-specific diagnostics at build time and in the editor.

The `tsconfig.json` already includes the plugin:

```json
{
  "compilerOptions": {
    "plugins": [{ "name": "@effect/language-service" }]
  }
}
```

### Build-time diagnostics (optional, opt-in)

`effect-language-service patch` modifies the local `node_modules/typescript` so that `tsc --noEmit` reports Effect-specific diagnostics. This is **opt-in** because it mutates your local install.

```bash
bun run prepare:effect-lsp     # alias for: effect-language-service patch
bun run typecheck              # now also catches "Effect must be yielded" and similar
```

The project does NOT add this as a `prepare` script. Patch only when you want it.

### Editor integration

For VS Code, Cursor, Zed or NVim, make sure the editor uses the workspace TypeScript (not the bundled one). In VS Code / Cursor, open a `.ts` file, click the TypeScript version in the status bar, and select **Use Workspace Version**.

The `opencode-v2-lsp-support` TypeScript LSP also picks up the workspace TypeScript and therefore respects the `@effect/language-service` plugin. A minimal `opencode.json` in the project root enables it:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "lsp": {
    "typescript": {
      "command": ["typescript-language-server", "--stdio"],
      "extensions": [".ts", ".tsx", ".mts", ".cts"]
    }
  }
}
```

## Development

```bash
bun install
bun run typecheck
bun run typecheck:tests
bun test
bun run build
```

Layout:

```
server.js                 # V2 local-directory entrypoint (re-exports dist/index.js)
src/
  index.ts                # re-exports the plugin
  plugin.ts               # V2 lifecycle: setup(), RPC, hook install, cleanup
  plugin-v2.ts            # V2 adapter: JSON Schema inputs, permission.assert, result mapping
  plugin-options.ts       # per-instance options + env precedence
  registrations.ts        # tool definitions + permission names
  notebook-hooks.ts       # pure changed/no-op rules and result helpers
  notebook-diagnostics.ts # pyright virtual-document diagnostics + LSP metadata
  virtual-materialize.ts  # safe notebook-adjacent sidecar writer/cleanup
  lsp.ts                  # virtual notebook document + position mapping for LSPs
  rpc.ts                  # public RPC contract (document method, changed event)
  tool.ts                 # internal zod tool contract shared by the 14 tool implementations
  domain/                 # zod schemas + types for cells, outputs, execution
  services/               # Effect-style services (Path, Permission, File, ...)
  format/                 # markdown / output / diagnostic / export formatters
  tools/                  # one file per tool, thin wrapper over services
  utils/                  # limits, paths, mime, truncate, json helpers
python/
  ipynb_runner.py         # JSON-stdin/stdout runner using nbformat + nbclient
  requirements.txt        # runtime execution deps
  requirements-test.txt   # CI/test deps (numpy, matplotlib, scikit-learn)
test/
  fixtures/               # simple, outputs, error, images
  unit/                   # bun:test suites
docs/
  architecture.md         # module map, lifecycle, LSP and file-safety invariants
  contributing.md         # setup, commands, adding tools, review/release checklist
```

The plugin targets `@opencode/plugin` 2.2.x (tested with 2.2.2). It is V2-only; there is no V1 `server()` entrypoint.

Architecture and contribution notes:

- [Architecture](https://github.com/Restodecoca/opencode-ipynb/blob/main/docs/architecture.md)
- [Contributing](https://github.com/Restodecoca/opencode-ipynb/blob/main/docs/contributing.md)
- [`opencode.example.jsonc`](https://github.com/Restodecoca/opencode-ipynb/blob/main/opencode.example.jsonc) is the versioned, machine-independent local config example. The real `opencode.jsonc` is intentionally not versioned because it contains machine-specific paths.

### Development environment on WSL

Use a native Linux Bun inside WSL, not the Windows npm shim. Running `bun install` through Windows Bun against a WSL path can corrupt `node_modules` or fail to replace `bun.lock`.

```bash
curl -fsSL https://bun.sh/install | bash
export PATH="$HOME/.bun/bin:$PATH"

uv venv .venv
uv pip install --python .venv/bin/python pip -r python/requirements-test.txt
.venv/bin/python -m ipykernel install --user --name python3
PATH="$PWD/.venv/bin:$PATH" bun test
```

## License

MIT. See `LICENSE`.
