import type { NotebookDiagnostic } from "../notebook-diagnostics.js"
import {
  MAX_DIAGNOSTICS_METADATA,
  MAX_DIAGNOSTICS_METADATA_BYTES
} from "./limits.js"

/** Cap diagnostics metadata by both entry count and serialized bytes. */
export const capDiagnosticMetadata = (
  diagnostics: ReadonlyArray<NotebookDiagnostic>
): ReadonlyArray<NotebookDiagnostic> => {
  const out: NotebookDiagnostic[] = []
  let bytes = 0
  for (const item of diagnostics.slice(0, MAX_DIAGNOSTICS_METADATA)) {
    const size = JSON.stringify(item).length
    if (bytes + size > MAX_DIAGNOSTICS_METADATA_BYTES) break
    bytes += size
    out.push(item)
  }
  return out
}
