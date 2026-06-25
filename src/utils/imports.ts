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

const IMPORT_LINE_PATTERN = /^\s*(?:from\s+([\w.]+)\s+import\s+(.+)|import\s+(.+))/m

const stripAlias = (piece: string): string => {
  const idx = piece.indexOf(" as ")
  return (idx === -1 ? piece : piece.slice(0, idx)).trim()
}

export const extractImportNames = (source: string): string[] => {
  const names: string[] = []
  const lines = source.split("\n")
  for (const line of lines) {
    if (line.trimStart().startsWith("#")) continue
    const match = line.match(IMPORT_LINE_PATTERN)
    if (!match) continue
    if (match[1] !== undefined && match[2] !== undefined) {
      for (const piece of match[2].split(",")) {
        const trimmed = stripAlias(piece)
        if (!trimmed) continue
        names.push(trimmed)
      }
      continue
    }
    const rest = match[3]
    if (rest === undefined) continue
    for (const piece of rest.split(",")) {
      const trimmed = stripAlias(piece)
      if (!trimmed) continue
      names.push(trimmed)
    }
  }
  return names
}
