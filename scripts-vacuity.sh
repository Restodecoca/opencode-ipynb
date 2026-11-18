#!/usr/bin/env bash
# Non-vacuity probes for the TLA+ specifications.
#
# Every good spec ships with a dishonest twin, and every checked invariant must
# constrain a reachable state. Each probe below is an invariant that NEGATES
# "the interesting state is reachable": if the probe is VIOLATED, that state is
# reachable and the real invariant is not vacuous. A probe that HOLDS means the
# spec no longer reaches the state it is supposed to constrain.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -n "${TLA_JAR:-}" ]; then
  tlc() { java -cp "$TLA_JAR" tlc2.TLC "$@"; }
elif command -v tlc >/dev/null 2>&1; then
  tlc() { command tlc "$@"; }
else
  echo "SKIP: neither tlc nor TLA_JAR is available" >&2
  exit 1
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

echo "== tla+ vacuity probes =="
cat > "$work/probe.py" <<'PY'
import os, subprocess, sys, tempfile, pathlib

jar = os.environ["TLA_JAR_ABS"]
specs = pathlib.Path(os.environ["SPECS_DIR"])
work = pathlib.Path(tempfile.mkdtemp())

BASE = {
    "KernelWarningRing": "CONSTANTS\n  Capacity = 3\n  Messages = {\"m1\", \"m2\", \"m3\", \"m4\", \"m5\"}\n  ClearThreshold = 2\n\nCONSTRAINT\n  StateConstraint\n",
    "NotebookAtomicReplace": "CHECK_DEADLOCK\n  FALSE\n",
    "NotebookExecutionSave": "CONSTRAINT\n  StateConstraint\n\nCHECK_DEADLOCK\n  FALSE\n",
    "NotebookWriteLock": "CONSTANTS\n  Writers = {\"w1\", \"w2\"}\n  None = \"none\"\n\nCONSTRAINT\n  StateConstraint\n\nCHECK_DEADLOCK\n  FALSE\n",
}

PROBES = [
    ("KernelWarningRing", "RingFilled", "Len(ring) = Capacity"),
    ("KernelWarningRing", "EpochAdvanced", "epochs >= 1"),
    ("KernelWarningRing", "CrossEpochDup", "\\E i, j \\in 1..Len(ring) : i # j /\\ ring[i] = ring[j] /\\ ringEpochs[i] # ringEpochs[j]"),
    ("KernelWarningRing", "DeliveredThree", "delivered >= 3"),
    ("NotebookAtomicReplace", "DoneUnraised", 'phase = "done" /\\ raised = FALSE'),
    ("NotebookAtomicReplace", "DoneRaised", 'phase = "done" /\\ raised'),
    ("NotebookAtomicReplace", "DoneAbsent", 'phase = "done" /\\ target = "absent"'),
    ("NotebookAtomicReplace", "DoneBackupLeft", 'phase = "done" /\\ backup = "old"'),
    ("NotebookAtomicReplace", "RestorePathReached", 'phase = "restoring"'),
    ("NotebookExecutionSave", "SavedReached", 'stage = "saved"'),
    ("NotebookExecutionSave", "AbortedReached", 'stage = "aborted"'),
    ("NotebookExecutionSave", "SaveAfterExternal", 'stage = "saved" /\\ snapshot >= 1'),
    ("NotebookWriteLock", "HeldNonEmpty", "Cardinality(held) = 1"),
    ("NotebookWriteLock", "HolderSet", "holder # None"),
    ("NotebookWriteLock", "WroteNonEmpty", "wrote # {}"),
    ("NotebookWriteLock", "StaleReachable", "\\E w \\in Writers : stale[w]"),
    ("NotebookWriteLock", "AbortReached", "\\E w \\in Writers : w \\notin running /\\ w \\notin wrote"),
]

failures = []
for module, name, predicate in PROBES:
    tla = work / f"{module}Probe.tla"
    cfg = work / f"{module}Probe.cfg"
    text = (specs / f"{module}.tla").read_text()
    probe_module = f"P{module}{name}"
    text = text.replace(f"MODULE {module}", f"MODULE {probe_module}", 1)
    lines = text.splitlines()
    term = max(
        index
        for index, line in enumerate(lines)
        if line.strip() and set(line.strip()) == {"="}
    )
    lines.insert(term, f"\n\\* probe: reachability of ({predicate})\nProbe == ~({predicate})\n")
    tla = work / f"{probe_module}.tla"
    tla.write_text("\n".join(lines) + "\n")
    cfg = work / f"{probe_module}.cfg"
    cfg.write_text(f"SPECIFICATION Spec\n\n{BASE[module]}\nINVARIANT\n  Probe\n")
    result = subprocess.run(
        ["java", "-cp", jar, "tlc2.TLC", "-config", cfg.name, tla.name, "-cleanup", "-nowarning"],
        cwd=work, capture_output=True, text=True
    )
    out = result.stdout + result.stderr
    violated = "Invariant Probe is violated" in out
    if violated:
        print(f"   reachable   {module}.{name}")
    else:
        failures.append(f"{module}.{name} unreachable: {predicate}")
        print(f"   UNREACHABLE {module}.{name}")

for failure in failures:
    print(f"FAIL {failure}", file=sys.stderr)
sys.exit(1 if failures else 0)
PY

TLA_JAR_ABS="$(printf '%s' "${TLA_JAR}")" SPECS_DIR="$root/specs" python3 "$work/probe.py"

echo "== all vacuity probes reachable =="
