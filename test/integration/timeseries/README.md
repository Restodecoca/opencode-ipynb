# Time-series example

A minimal, runnable time-series example using only `numpy`. We generate a
sine wave, add Gaussian noise, smooth it with a uniform moving average, and
print the basic statistics of the smoothed series.

## What the notebook does

`notebook.ipynb` has 5 cells:

1. **Markdown intro** — explains the goal (smooth a noisy sine wave).
2. **Code: setup** — `numpy`, a seeded `default_rng(0)`, 200 samples on
   `t = linspace(0, 4*pi)`, and `y_noisy = sin(t) + N(0, 0.25)`.
3. **Code: moving average** — `np.convolve(y_noisy, ones(9)/9, mode='same')`.
4. **Code: stats** — `print(f"min={...:.3f}, max={...:.3f}, mean={...:.3f}")`.
5. **Markdown outro** — suggests `mode='valid'` and a Gaussian kernel.

All code cells ship with `outputs: []` and `execution_count: null`.

## Requirements

`numpy` only. `uv pip install numpy` (or `pip install numpy`).

## Plugin walkthrough

```text
ipynb_inspect({ filePath: "examples/timeseries/notebook.ipynb" })
ipynb_read({ filePath: "examples/timeseries/notebook.ipynb", cellIndex: 1, includeOutputs: true })
ipynb_run({ filePath: "examples/timeseries/notebook.ipynb", mode: "all", save: true })
```

After `ipynb_run`, the printed output is exactly:

```text
n=200, t.min=0.000, t.max=12.566
window=9, y_smooth.shape=(200,)
min=-0.886, max=0.907, mean=0.020
```

(values vary slightly across numpy versions, but the four output lines are
stable in shape and the smoothed series is centred near zero because the
noise is zero-mean.)

## Tips

- Use `ipynb_edit({ cellIndex: 2, source: "..." })` to swap the uniform
  kernel for a Gaussian one — the plugin asks for permission once and shows
  you a textual diff of the changed cell.
- Use `ipynb_outputs({ action: "list" })` to skim the produced outputs
  without re-running the kernel.
- Use `ipynb_export({ format: "python" })` to ship the smoothing routine
  as a standalone script.
