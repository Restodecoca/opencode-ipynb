const STDLIB_MODULES: ReadonlySet<string> = new Set([
  "os", "sys", "re", "json", "math", "time", "datetime", "collections", "itertools",
  "functools", "pathlib", "typing", "copy", "io", "string", "random", "statistics",
  "decimal", "fractions", "enum", "abc", "contextlib", "dataclasses", "asyncio",
  "concurrent", "multiprocessing", "threading", "socket", "http", "urllib", "email",
  "html", "xml", "csv", "configparser", "argparse", "logging", "unittest", "pdb",
  "traceback", "warnings", "weakref", "gc", "inspect", "dis", "ast", "types",
  "importlib", "pkgutil", "modulefinder", "ctypes", "platform", "errno", "signal",
  "subprocess", "shutil", "glob", "fnmatch", "tempfile", "fileinput", "stat",
  "filecmp", "pickle", "shelve", "dbm", "sqlite3", "zlib", "gzip", "bz2", "lzma",
  "zipfile", "tarfile", "hashlib", "hmac", "secrets", "ssl", "socketserver", "xmlrpc",
  "ipaddress", "gettext", "locale", "calendar", "textwrap", "unicodedata",
  "stringprep", "pprint", "reprlib", "graphlib", "zoneinfo", "tomllib", "selectors",
  "struct", "codecs", "base64", "binascii", "quopri", "uu", "binhex", "xdrlib",
  "netrc", "robotparser", "faulthandler", "tracemalloc", "tokenize", "tabnanny",
  "pyclbr", "py_compile", "compileall", "zipimport", "site", "sysconfig", "builtins",
  "copyreg", "UserDict", "UserList", "UserString", "string", "numbers", "math",
  "cmath", "operator", "functools", "itertools", "keyword", "heapq", "bisect"
])

export const isStdlibModule = (name: string): boolean => STDLIB_MODULES.has(name)

export const isRelativeImport = (name: string): boolean => name.startsWith(".")

const stripComment = (line: string): string => line.replace(/#.*$/, "")

const TRIPLE_DOUBLE = /"""[\s\S]*?"""/g
const TRIPLE_SINGLE = /'''[\s\S]*?'''/g

/**
 * Extract the top-level modules imported by Python source. For
 * `from pandas import DataFrame` the module is `pandas`, not `DataFrame`.
 * This is intentionally a lightweight parser (not a Python AST); it handles
 * aliases, comments, dotted modules, and parenthesized from-imports.
 */
export const extractImportNames = (source: string): string[] => {
  const names: string[] = []
  // Strip triple-quoted bodies first; the line parser below never scans past
  // a single line, so blank/whitespace-heavy notebooks stay linear.
  const withoutCommentLines = source.replace(/^[ \t]*#[^\n]*$/gm, "")
  const withoutStrings = withoutCommentLines
    .replace(TRIPLE_DOUBLE, "")
    .replace(TRIPLE_SINGLE, "")
    .replace(/\\\r?\n/g, " ")
  const fromPattern =
    /^[ \t]*from[ \t]+([A-Za-z_][\w.]*|\.+[A-Za-z_][\w.]*)[ \t]+import\b/
  const importPattern = /^[ \t]*import[ \t]+(.+)$/
  for (const rawLine of withoutStrings.split("\n")) {
    const line = stripComment(rawLine)
    const fromMatch = fromPattern.exec(line)
    if (fromMatch !== null) {
      const module = fromMatch[1]!
      if (module === "__future__" || isRelativeImport(module)) continue
      names.push(module.split(".")[0]!)
      continue
    }
    const importMatch = importPattern.exec(line)
    if (importMatch === null) continue
    for (const piece of importMatch[1]!.split(";")[0]!.split(",")) {
      const module = piece.trim().split(/\s+as\s+/)[0]?.trim()
      if (!module) continue
      if (!isRelativeImport(module)) names.push(module)
    }
  }
  return [...new Set(names)]
}
