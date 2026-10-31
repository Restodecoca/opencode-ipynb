import type { V2ToolRegistration } from "./plugin-v2.js"
import type { AnyToolDefinition } from "./tool.js"
import { ipynbInspectTool } from "./tools/inspect.js"
import { ipynbReadTool } from "./tools/read.js"
import { ipynbEditTool } from "./tools/edit.js"
import { ipynbCellInsertTool } from "./tools/cell_insert.js"
import { ipynbCellDeleteTool } from "./tools/cell_delete.js"
import { ipynbCellMoveTool } from "./tools/cell_move.js"
import { ipynbRunTool } from "./tools/run.js"
import { ipynbOutputsTool } from "./tools/outputs.js"
import { ipynbCleanTool } from "./tools/clean.js"
import { ipynbExportTool } from "./tools/export.js"
import { ipynbDoctorTool } from "./tools/doctor.js"
import { ipynbReproTool } from "./tools/repro.js"
import { ipynbKernelTool } from "./tools/kernel.js"
import { ipynbLspTool } from "./tools/lsp.js"

export const toolDefinitions: Record<string, AnyToolDefinition> = {
  ipynb_inspect: ipynbInspectTool,
  ipynb_read: ipynbReadTool,
  ipynb_edit: ipynbEditTool,
  ipynb_cell_insert: ipynbCellInsertTool,
  ipynb_cell_delete: ipynbCellDeleteTool,
  ipynb_cell_move: ipynbCellMoveTool,
  ipynb_run: ipynbRunTool,
  ipynb_outputs: ipynbOutputsTool,
  ipynb_clean: ipynbCleanTool,
  ipynb_export: ipynbExportTool,
  ipynb_doctor: ipynbDoctorTool,
  ipynb_repro: ipynbReproTool,
  ipynb_kernel: ipynbKernelTool,
  ipynb_lsp: ipynbLspTool
}

// The permission name declared on a V2 tool is matched against the user's
// permission rules. Mutating tools map to "edit"; execution maps to "shell";
// the mixed LSP tool maps to "lsp" (its materialize branch additionally asks
// for edit on the sidecar path). Per-call approval still goes through
// ctx.permission.assert.
export const permissionByTool: Record<string, string> = {
  ipynb_inspect: "read",
  ipynb_read: "read",
  ipynb_edit: "edit",
  ipynb_cell_insert: "edit",
  ipynb_cell_delete: "edit",
  ipynb_cell_move: "edit",
  ipynb_clean: "edit",
  ipynb_run: "shell",
  ipynb_repro: "read",
  ipynb_lsp: "lsp"
}

export const v2ToolRegistrations: ReadonlyArray<V2ToolRegistration> =
  Object.entries(toolDefinitions).map(([name, definition]) => {
    const permission = permissionByTool[name]
    return permission === undefined
      ? { name, definition }
      : { name, definition, permission }
  })
