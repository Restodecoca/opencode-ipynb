// Thin re-export so tools/ can use the same resolver as services/.
// Keeping the implementation in services/index.ts ensures both layers
// agree on env handling and fallback semantics.
export { resolveOptionsFromEnv as resolveToolOptions } from "../services/index.js"
