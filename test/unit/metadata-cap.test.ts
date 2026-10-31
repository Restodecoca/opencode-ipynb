import { describe, expect, it } from "bun:test"
import { capDiagnosticMetadata } from "../../src/utils/metadata.js"
import {
  MAX_DIAGNOSTICS_METADATA,
  MAX_DIAGNOSTICS_METADATA_BYTES
} from "../../src/utils/limits.js"
import type { NotebookDiagnostic } from "../../src/notebook-diagnostics.js"

const makeDiagnostic = (index: number): NotebookDiagnostic => ({
  cellIndex: index,
  line: 0,
  character: 0,
  endLine: 0,
  endCharacter: 1,
  severity: "error",
  message: "m".repeat(2_000),
  rule: "r".repeat(200)
})

describe("capDiagnosticMetadata", () => {
  it("caps both entry count and serialized bytes", () => {
    const input = Array.from(
      { length: MAX_DIAGNOSTICS_METADATA + 100 },
      (_, i) => makeDiagnostic(i)
    )
    const out = capDiagnosticMetadata(input)
    expect(out.length).toBeLessThanOrEqual(MAX_DIAGNOSTICS_METADATA)
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(
      MAX_DIAGNOSTICS_METADATA_BYTES + 4
    )
  })
})
