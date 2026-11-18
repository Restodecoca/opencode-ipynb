import { describe, expect, it } from "bun:test"
import { applyEdits } from "../../src/utils/json-patch.js"

describe("applyEdits", () => {
  it("splices non-overlapping edits in sorted order even when given unsorted", () => {
    expect(
      applyEdits("0123456789", [
        { start: 8, end: 9, text: "B" },
        { start: 2, end: 3, text: "A" }
      ])
    ).toBe("01A34567B9")
  })

  it("keeps a late edit last when the pair is sorted but unsorted in the input", () => {
    expect(
      applyEdits("0123456789", [
        { start: 10, end: 20, text: "A" },
        { start: 5, end: 6, text: "B" }
      ])
    ).toBe("01234B6789A")
  })

  it("accepts adjacent edits whose boundaries touch", () => {
    expect(
      applyEdits("abcd", [
        { start: 0, end: 2, text: "X" },
        { start: 2, end: 4, text: "Y" }
      ])
    ).toBe("XY")
  })

  it("rejects a sorted overlapping pair", () => {
    expect(
      applyEdits("0123456789", [
        { start: 1, end: 5, text: "X" },
        { start: 4, end: 7, text: "Y" }
      ])
    ).toBeUndefined()
  })

  it("rejects an overlapping pair after sorting", () => {
    expect(
      applyEdits("0123456789", [
        { start: 4, end: 7, text: "Y" },
        { start: 1, end: 5, text: "X" }
      ])
    ).toBeUndefined()
  })

  it("breaks equal starts by end, letting a shorter edit that ends first apply", () => {
    expect(
      applyEdits("0123456789", [
        { start: 5, end: 10, text: "A" },
        { start: 5, end: 5, text: "B" }
      ])
    ).toBe("01234BA")
  })

  it("returns the text untouched for an empty edit list", () => {
    expect(applyEdits("abc", [])).toBe("abc")
  })
})
