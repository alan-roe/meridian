/**
 * Unit tests for model mapping and utility functions.
 */
import { describe, it, expect } from "bun:test"
import { mapModelToClaudeModel, isClosedControllerError } from "../proxy/models"

describe("mapModelToClaudeModel", () => {
  it("maps opus models to opus[1m]", () => {
    expect(mapModelToClaudeModel("claude-opus-4-5")).toBe("opus[1m]")
    expect(mapModelToClaudeModel("opus")).toBe("opus[1m]")
    expect(mapModelToClaudeModel("claude-opus-4-6")).toBe("opus[1m]")
  })

  it("maps haiku models to haiku", () => {
    expect(mapModelToClaudeModel("claude-haiku-4-5")).toBe("haiku")
    expect(mapModelToClaudeModel("haiku")).toBe("haiku")
  })

  it("defaults to sonnet[1m] for sonnet models", () => {
    expect(mapModelToClaudeModel("claude-sonnet-4-5")).toBe("sonnet[1m]")
    expect(mapModelToClaudeModel("sonnet")).toBe("sonnet[1m]")
    expect(mapModelToClaudeModel("claude-sonnet-4-5-20250929")).toBe("sonnet[1m]")
  })

  it("defaults to sonnet[1m] for unknown models", () => {
    expect(mapModelToClaudeModel("unknown-model")).toBe("sonnet[1m]")
    expect(mapModelToClaudeModel("")).toBe("sonnet[1m]")
  })
})

describe("isClosedControllerError", () => {
  it("returns true for Controller is already closed error", () => {
    expect(isClosedControllerError(new Error("Controller is already closed"))).toBe(true)
  })

  it("returns true when message contains the phrase", () => {
    expect(isClosedControllerError(new Error("Error: Controller is already closed foo"))).toBe(true)
  })

  it("returns false for other errors", () => {
    expect(isClosedControllerError(new Error("something else"))).toBe(false)
  })

  it("returns false for non-Error values", () => {
    expect(isClosedControllerError("string")).toBe(false)
    expect(isClosedControllerError(null)).toBe(false)
    expect(isClosedControllerError(undefined)).toBe(false)
    expect(isClosedControllerError(42)).toBe(false)
  })
})
