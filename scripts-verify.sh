#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "== lean proofs =="
(cd "$root/proofs" && lake build)

echo "== tla+ model check =="
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

echo "== all checks passed =="
