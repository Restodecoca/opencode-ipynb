# Classification example

A minimal, runnable classification example built around `sklearn.datasets.load_iris`,
a `LogisticRegression`, and a one-line accuracy print. No CSV file is needed.

## What the notebook does

`notebook.ipynb` has 7 cells:

1. **Markdown intro** — describes the pipeline (load, split, fit, score).
2. **Code: imports** — `numpy`, `load_iris`, `train_test_split`, `LogisticRegression`, `accuracy_score`.
3. **Code: load data** — `iris = load_iris()` and prints the shape and class names.
4. **Code: split** — 80/20 stratified split with `random_state=42`.
5. **Code: fit** — `LogisticRegression(max_iter=200)`.
6. **Code: score** — `print(f"accuracy: {acc:.3f}")`.
7. **Markdown outro** — suggests two follow-up experiments.

All code cells ship with `outputs: []` and `execution_count: null` so the
notebook is reproducible; run it with `ipynb_run` to populate outputs.

## Requirements

`numpy` and `scikit-learn`. The plugin does not install these. The most common
setup is `uv pip install scikit-learn numpy` (or `pip install scikit-learn numpy`).

## Plugin walkthrough

```text
ipynb_inspect({ filePath: "examples/classification/notebook.ipynb" })
ipynb_read({ filePath: "examples/classification/notebook.ipynb", cellIndex: 5 })
ipynb_run({ filePath: "examples/classification/notebook.ipynb", mode: "all", save: true })
```

After `ipynb_run`, the printed output is exactly:

```text
X.shape=(150, 4), classes=['setosa', 'versicolor', 'virginica']
train=120, test=30
fit done
accuracy: 0.967
```

(Accuracy on the deterministic 80/20 split is 0.967; the small print buffer
keeps the response well under `defaultMaxOutputChars`.)

## Tips

- Use `ipynb_cell_insert` to add a confusion-matrix cell right after the
  accuracy print (the agent only needs to know the cell index and the source).
- Use `ipynb_clean` before committing the notebook to keep the diff small;
  with `save: true` and a follow-up `ipynb_clean` you get a clean history.
- Use `ipynb_export({ format: "python" })` to turn this notebook into a flat
  script for CI or for sharing with a non-notebook reviewer.
