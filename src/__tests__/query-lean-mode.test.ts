/**
 * Tests for lean-mode behaviour in buildQueryOptions.
 *
 * Lean mode strips the SDK tool catalog and CLAUDE.md from the upstream
 * payload (same as passthrough) but keeps the internal-mode multi-turn
 * budget so structured-output round-trips work. WebSearch / WebFetch are
 * left available by virtue of the lean adapter excluding them from the
 * blocklist; this file does not test that lookup — see
 * adapter-detection.test.ts and lean.ts directly.
 */
import { describe, it, expect } from "bun:test"
import { buildQueryOptions, type QueryContext } from "../proxy/query"
import { BLOCKED_BUILTIN_TOOLS, CLAUDE_CODE_ONLY_TOOLS, MCP_SERVER_NAME, ALLOWED_MCP_TOOLS } from "../proxy/tools"

function makeContext(overrides: Partial<QueryContext> = {}): QueryContext {
  return {
    prompt: "Enrich this product",
    model: "sonnet",
    workingDirectory: "/tmp/test",
    systemContext: "",
    claudeExecutable: "/usr/bin/claude",
    passthrough: false,
    stream: false,
    sdkAgents: {},
    cleanEnv: {},
    hasDeferredTools: false,
    isUndo: false,
    blockedTools: BLOCKED_BUILTIN_TOOLS,
    incompatibleTools: CLAUDE_CODE_ONLY_TOOLS,
    mcpServerName: MCP_SERVER_NAME,
    allowedMcpTools: ALLOWED_MCP_TOOLS,
    ...overrides,
  }
}

describe("buildQueryOptions — lean mode", () => {
  it("sets tools: [] (strips upstream catalog) when leanMode is true", () => {
    const result = buildQueryOptions(makeContext({ leanMode: true }))
    expect(result.options.tools).toEqual([])
  })

  it("sets settingSources: [] (no CLAUDE.md) when leanMode is true", () => {
    const result = buildQueryOptions(makeContext({ leanMode: true }))
    expect(result.options.settingSources).toEqual([])
  })

  it("does not strip tools when leanMode is false and not passthrough", () => {
    const result = buildQueryOptions(makeContext({ leanMode: false, passthrough: false }))
    expect(result.options.tools).toBeUndefined()
  })

  it("uses maxTurns: 30 in lean mode (not the passthrough cap of 3)", () => {
    const result = buildQueryOptions(makeContext({ leanMode: true }))
    expect(result.options.maxTurns).toBe(30)
  })

  it("uses maxTurns: 200 in plain internal mode", () => {
    const result = buildQueryOptions(makeContext({ leanMode: false, passthrough: false }))
    expect(result.options.maxTurns).toBe(200)
  })

  it("does not register the OpenCode MCP server in lean mode", () => {
    const result = buildQueryOptions(makeContext({ leanMode: true }))
    expect(result.options.mcpServers).toBeUndefined()
  })

  it("registers the OpenCode MCP server in plain internal mode", () => {
    const result = buildQueryOptions(makeContext({ leanMode: false, passthrough: false }))
    expect(result.options.mcpServers).toBeDefined()
  })

  it("still applies disallowedTools (blocked-builtin list) in lean mode", () => {
    // The lean *adapter* supplies a blocklist that excludes WebSearch/WebFetch;
    // here we just verify the disallow plumbing is still wired regardless of mode.
    const result = buildQueryOptions(makeContext({
      leanMode: true,
      blockedTools: ["Read", "Write"],
      incompatibleTools: [],
    }))
    expect(result.options.disallowedTools).toEqual(["Read", "Write"])
  })

  it("does not use the claude_code system-prompt preset in lean mode", () => {
    // Lean mode should behave like passthrough for system-prompt resolution:
    // no claude_code preset, just whatever the client supplies.
    const result = buildQueryOptions(makeContext({
      leanMode: true,
      systemContext: "You enrich PIM records.",
    }))
    expect(result.options.systemPrompt).toBe("You enrich PIM records.")
  })
})
