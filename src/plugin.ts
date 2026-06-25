import type { Plugin } from "@opencode-ai/plugin"
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
import { parsePluginOptions } from "./plugin-options.js"
import { disposeSharedKernelManager } from "./services/index.js"

const plugin: Plugin = async (_input, options) => {
  const parsed = parsePluginOptions(options)
  if (parsed.pythonPath && !process.env.OPENCODE_IPYNB_PYTHON) {
    process.env.OPENCODE_IPYNB_PYTHON = parsed.pythonPath
  }
  if (!process.env.OPENCODE_IPYNB_OPTIONS) {
    process.env.OPENCODE_IPYNB_OPTIONS = JSON.stringify(parsed)
  }
  return {
    tool: {
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
      ipynb_kernel: ipynbKernelTool
    },
    dispose: async () => {
      // Kill every live warm kernel so we do not leave zombie Python
      // subprocesses when the OpenCode session ends.
      await disposeSharedKernelManager()
    }
  }
}

export default plugin
