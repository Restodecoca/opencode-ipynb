#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "== lean proofs =="
if command -v lake >/dev/null 2>&1; then
  (cd "$root/proofs" && lake build)
else
  echo "SKIP: lake not on PATH" >&2
  exit 1
fi

echo "== tla+ model check =="
if [ -n "${TLA_JAR:-}" ]; then
  tlc() { java -cp "$TLA_JAR" tlc2.TLC "$@"; }
elif command -v tlc >/dev/null 2>&1; then
  tlc() { command tlc "$@"; }
else
  echo "SKIP: neither tlc nor TLA_JAR is available" >&2
  exit 1
fi
export -f tlc 2>/dev/null || true

for cfg in "$root"/specs/*.cfg; do
  name="$(basename "${cfg%.cfg}")"
  expected_file="$root/specs/$name.expect"
  echo "-- $name"
  out="$(cd "$root/specs" && tlc -config "$name.cfg" "$name.tla" -cleanup 2>&1 || true)"
  if [ -f "$expected_file" ]; then
    want="$(cat "$expected_file")"
    if printf '%s\n' "$out" | grep -qF "$want"; then
      echo "   ok (expected: $want)"
      continue
    fi
    echo "FAIL $name: expected '$want'" >&2
    printf '%s\n' "$out" | tail -20 >&2
    exit 1
  fi
  if printf '%s\n' "$out" | grep -qE '^(Error|Temporal properties were violated)'; then
    echo "FAIL $name" >&2
    printf '%s\n' "$out" | tail -20 >&2
    exit 1
  fi
  printf '%s\n' "$out" | grep -E 'states generated' | tail -1 | sed 's/^/   /'
done

rm -f "$root"/specs/*_TTrace_*.bin "$root"/specs/*_TTrace_*.tla

echo "== tla+ vacuity probes =="
"$root/scripts-vacuity.sh"

echo "== all checks passed =="
