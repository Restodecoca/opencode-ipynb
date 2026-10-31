// OpenCode V2 resolves a local plugin directory by trying `<dir>/server` first.
// Keep this stable entrypoint at the package root and re-export the built plugin.
export { default } from "./dist/index.js"
