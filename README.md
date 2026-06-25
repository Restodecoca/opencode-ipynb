# opencode-ipynb

A community [OpenCode](https://opencode.ai) plugin that adds robust support for Jupyter Notebook (`.ipynb`) files: inspect, read, edit, run, outputs, clean, export, reproducibility reports, and warm Python kernels.

The plugin is **opt-in**, distributed via npm, and does not modify the OpenCode core. It exposes thirteen agent tools that operate on `.ipynb` files with explicit permissions, granular context control, and a strongly-typed [Effect](https://effect.website) runtime internally.

> Repository: https://github.com/Restodecoca/opencode-ipynb
> Issues: https://github.com/Restodecoca/opencode-ipynb/issues

## Why a plugin and not core

- Notebooks are large, binary-like artifacts. Dumping them into the agent context burns tokens.
- Reading outputs and editing cells are high-trust actions that must ask permission every time.
- The execution flow needs a Python runtime, which is not something every OpenCode user wants installed.
- A plugin lets the community iterate on these workflows without forcing changes on the OpenCode core.

## Installation

After the package is published on npm, add it to your `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-ipynb"]
}
```

For local development, point OpenCode at a checkout or built tarball:

```json
{
  "plugin": ["file:./opencode-ipynb"]
}
```

Or run directly from this repo:

```bash
git clone https://github.com/Restodecoca/opencode-ipynb
cd opencode-ipynb
bun install
bun run build
```

Then add `"opencode-ipynb"` (or the local path) to your `opencode.json`.

## Tools

| Tool                 | Purpose |
| -------------------- | ------- |
| `ipynb_inspect`      | Compact summary: kernel/language metadata, cell table, output stats, execution-order warnings, optional missing-package checks. |
| `ipynb_read`         | Granular read of one cell or a range, with optional outputs/errors/metadata/images and truncation limits. |
| `ipynb_edit`         | Safe per-cell source edit with textual diff, output clearing policy, permission gate, and per-file lock. |
| `ipynb_cell_insert`  | Insert a code/markdown/raw cell before or after a target index. |
| `ipynb_cell_delete`  | Delete one cell by index and return a preview of the deleted source. |
| `ipynb_cell_move`    | Move one cell to a new index. |
| `ipynb_run`          | Execute one cell, a range, from a cell, or a full notebook via the Python helper. Supports save-to-notebook and optional warm kernels. |
| `ipynb_outputs`      | List / read / read_error / clear_cell / clear_all outputs with pagination and permission gates for writes. |
| `ipynb_clean`        | Strip outputs, execution counts, widget state, large images, and normalize `source` arrays for Git-friendly diffs. |
| `ipynb_export`       | Export to Markdown, Python, or summary; optionally write to disk after permission. |
| `ipynb_doctor`       | Diagnose Python, helper discovery, and required Jupyter dependencies. |
| `ipynb_repro`        | Reproducibility report: kernel/env info, `pip freeze`, filesystem reads, random seeds, non-determinism, missing packages. |
| `ipynb_kernel`       | Inspect/restart/shutdown warm kernels when `ipynb.warmKernel: true` is enabled. |

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

## Safety and permissions

- Every write (`ipynb_edit`, `ipynb_clean`, `ipynb_outputs clear_*`, `ipynb_export --outputPath`) calls `context.ask` before touching the disk.
- Every execution (`ipynb_run`) calls `context.ask` with rich metadata: file path, mode (`cell` / `range` / `all` / `from`), cell range, save flag, working directory, timeout.
- `PathService` rejects paths that resolve outside of the OpenCode worktree. The lock manager serializes per-file writes to prevent accidental corruption.
- The Python execution helper is an opt-in, isolated subprocess; it does not auto-install Jupyter. The user installs `python/requirements.txt` only when they want real execution.

## Context control

Notebooks can be enormous. By default the plugin never dumps a full notebook into context:

- `ipynb_inspect` returns a table with the first line of every cell, plus aggregate counts. It never includes the full source.
- `ipynb_read` defaults to **not** including outputs. Set `includeOutputs: true` to opt in. Images / base64 are always omitted (you only get a size notice).
- `maxSourceChars` (default 12 000) and `maxOutputChars` (default 6 000) cap the size of any single response.
- `maxTracebackChars` (default 8 000) caps error tracebacks.
- Every truncation appends `... (truncated, use maxXxx to increase)`.

The relevant constants live in `src/utils/limits.ts`.

## Python execution

The plugin **never installs Python dependencies automatically**. Running `ipynb_run` is opt-in and requires a Python environment with `nbformat`, `nbclient`, `jupyter_client`, and `ipykernel`. The plugin only detects what is available and tells you how to fix what is missing.

### Preferred: `uv`

```bash
uv pip install nbformat nbclient jupyter_client ipykernel
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

OpenCode may use a different Python interpreter than the one in your terminal. Three ways to tell the plugin which one to use, in priority order:

1. Plugin options (in `opencode.json`):

   ```json
   {
     "plugin": ["opencode-ipynb"],
     "ipynb": {
       "pythonPath": "C:/Users/Gabriel/miniconda3/envs/data/python.exe",
        "preferUv": true,
        "defaultTimeoutMs": 120000,
        "defaultMaxOutputChars": 6000,
        "warmKernel": false,
        "allowOutsideWorktree": false
      }
   }
   ```

   - `pythonPath` (string): absolute path to a Python interpreter.
   - `preferUv` (boolean, default `true`): the doctor and the Python service prefer `uv pip install` over `pip install` in their suggestions.
   - `defaultTimeoutMs` (number, default `120000`): timeout in milliseconds for `ipynb_run`.
   - `defaultMaxOutputChars` (number, default `6000`): fallback for `ipynb_read` and `ipynb_outputs read` when the user does not pass `maxOutputChars`.
   - `warmKernel` (boolean, default `false`): keep a long-lived Python subprocess per notebook path for faster repeated `ipynb_run mode=all` / `mode=cell` calls. Manage it with `ipynb_kernel`.
   - `allowOutsideWorktree` (boolean, default `false`): power-user escape hatch — when `true`, the plugin will read and write `.ipynb` files outside the OpenCode worktree. Leave at `false` unless you know why you need it.

2. Environment variables (the shell wins over plugin options):

   ```bash
   OPENCODE_IPYNB_PYTHON=C:/Users/Gabriel/miniconda3/envs/data/python.exe opencode
   OPENCODE_IPYNB_OPTIONS='{"pythonPath":"/usr/bin/python3","defaultMaxOutputChars":4000}' opencode
   ```

   `OPENCODE_IPYNB_PYTHON` overrides `ipynb.pythonPath` only. `OPENCODE_IPYNB_OPTIONS` overrides the whole `ipynb.*` block (a JSON object validated by the same schema as `opencode.json`). These are both set by the plugin on first load if they are not already set in the environment, so an explicit shell value always wins.

3. PATH fallback: the plugin tries `python`, then `python3`.

### Diagnose first

If anything goes wrong, run:

```text
ipynb_doctor
```

It reports the selected interpreter, every Jupyter dependency (`[ok]` / `[missing]`), where the helper script was found, and a copy-pasteable install command. It never installs anything.

## Known limitations

- Python execution depends on the user's local Python/Jupyter environment. The plugin diagnoses missing packages but never installs them.
- Warm kernels are intentionally limited to `ipynb_run mode=all` and `mode=cell`; `range`, `from`, and `env` use one-shot helper processes.
- Large notebooks and rich outputs are truncated in tool responses to protect context. When `ipynb_run save=true`, full nbformat outputs are preserved on disk.
- `allowOutsideWorktree` is a power-user escape hatch. Keep it disabled unless you explicitly need cross-worktree notebook access.

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

The published npm tarball contains only the runtime: `dist/`, `python/ipynb_runner.py`, `python/requirements.txt`, `README.md`, and `LICENSE`. Internal developer docs (`AGENTS.md`, `TODO.md`, this repo's scripts and CI) are excluded from the npm package via `.npmignore`, but they are versioned in this repository for contributors.

Cut a release by tagging the commit and pushing the tag, then publish it on GitHub — the workflow runs only on the `published` release event:

```bash
git tag v0.1.0 && git push --tags
```

Then create a GitHub release at https://github.com/Restodecoca/opencode-ipynb/releases/new pointing at `v0.1.0`. The CI runs `bun run typecheck`, `bun test`, and `bun run build` before `npm publish --provenance --access public`. The repository must have a single secret configured: `NPM_TOKEN` (an npm automation token with publish rights for the package name in `package.json`).

Before publishing, run a local package check:

```bash
bun run typecheck
bun test
bun run build
npm pack --dry-run
```

The package name `opencode-ipynb` is currently available on npm. If you publish under a scope instead, update `package.json`, the install snippet, and this release tag convention together.

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

The OpenCode TypeScript LSP (built-in) also picks up the workspace TypeScript and therefore respects the `@effect/language-service` plugin. A minimal `opencode.json` in the project root enables it:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "lsp": {
    "typescript": {
      "extensions": [".ts", ".tsx", ".mts", ".cts"]
    }
  }
}
```

## Development

```bash
bun install
bun run typecheck
bun test
bun run build
```

Layout:

```
src/
  index.ts                # re-exports the plugin
  plugin.ts               # Plugin object, registers all 13 tools
  domain/                 # zod schemas + types for cells, outputs, execution
  services/               # Effect-style services (Path, Permission, File, ...)
  format/                 # markdown / output / diagnostic / export formatters
  tools/                  # one file per tool, thin wrapper over services
  utils/                  # limits, paths, mime, truncate, json helpers
python/
  ipynb_runner.py         # JSON-stdin/stdout runner using nbformat + nbclient
  requirements.txt
test/
  fixtures/               # simple, outputs, error, images
  unit/                   # bun:test suites
```

## Roadmap

See `TODO.md` for the full plan and review-fix history (v0.1 → v1.5). Highlights:

- v0.2: polished `ipynb_outputs` UI, full `ipynb_export` polish.
- v0.3: real `nbclient`-based execution, save outputs, timeout, traceback capture.
- v0.4: image attachments, reproducibility reports.
- v1.0: kernel lifecycle management, cross-platform tests, npm publish.
- v1.1–v1.5: security, Effect, path, packaging, rich-output, and cleanup review fixes.

## License

MIT. See `LICENSE`.
