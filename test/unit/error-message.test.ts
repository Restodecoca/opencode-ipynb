import { describe, expect, it } from "bun:test"
import { errorToMessage, NotebookValidationError } from "../../src/domain/errors.js"

describe("errorToMessage > NotebookValidation", () => {
  it("includes a compact preview of the issues", () => {
    const message = errorToMessage(
      new NotebookValidationError({
        message: "bad notebook",
        filePath: "/tmp/n.ipynb",
        issues: ["a", "b", "c", "d"]
      })
    )
    expect(message).toContain("4 issue(s)")
    expect(message).toContain("a; b; c")
    expect(message).toContain("+1 more")
  })

  it("omits the preview separator when there are no issues", () => {
    const message = errorToMessage(
      new NotebookValidationError({
        message: "bad notebook",
        filePath: "/tmp/n.ipynb",
        issues: []
      })
    )
    expect(message).toContain("0 issue(s)")
    expect(message).not.toContain(": )")
  })
})
