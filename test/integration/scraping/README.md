# Scraping example

A minimal, runnable scraping example using only the Python standard library:
`urllib.request` for the HTTP fetch and `html.parser` for the `<title>` extraction.
No third-party packages are required.

## What the notebook does

`notebook.ipynb` has 4 cells:

1. **Markdown intro** — explains the goal and the standard-library-only choice.
2. **Code: imports** — `urllib.request` and `html.parser.HTMLParser`.
3. **Code: fetch + parse + print** — a small `TitleParser` subclass, a 10s
   timeout, a `User-Agent` header (to avoid 403s from some servers), and a
   `try/except` that prints `fetch failed: <ErrorType>: <message>` on
   network errors so the cell always produces output.
4. **Markdown outro** — suggests swapping the URL or extending the parser.

All code cells ship with `outputs: []` and `execution_count: null`.

## Requirements

None beyond a working Python 3 interpreter. The example uses only the standard
library, which the plugin never touches.

## Plugin walkthrough

```text
ipynb_inspect({ filePath: "examples/scraping/notebook.ipynb" })
ipynb_read({ filePath: "examples/scraping/notebook.ipynb", cellIndex: 2 })
ipynb_run({ filePath: "examples/scraping/notebook.ipynb", mode: "all", save: true })
```

After `ipynb_run` with network access, the printed output is exactly:

```text
status=200, title='Example Domain'
```

If the network is down, the cell prints something like:

```text
fetch failed: URLError: <urlopen error [Errno ...] ...>
```

The plugin does not need special handling for this — the cell is well-formed
Python and `ipynb_run` captures the print output normally.

## Tips

- Use `ipynb_edit({ cellIndex: 2, source: "..." })` to point the fetch at a
  different small public page; the plugin returns a textual diff so you can
  review the change before accepting it.
- Use `ipynb_run({ mode: "cell", cellIndex: 2 })` to re-run just the fetch
  cell after editing it, without re-executing the imports.
- Use `ipynb_clean` after running to strip the saved outputs from the
  on-disk notebook so the JSON diff stays small in version control.
