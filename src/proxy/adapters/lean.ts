/**
 * Lean adapter — minimal-context structured-output endpoint.
 *
 * Strips the SDK's ~25k-token tool catalog and CLAUDE.md from the upstream
 * payload (same mechanism as passthrough mode), but stays in internal mode
 * so multi-turn structured output (output_config / StructuredOutput tool
 * round-trip) has the turn budget it needs. Unblocks WebSearch and WebFetch
 * for retrieval-augmented enrichment.
 *
 * Selected by `x-meridian-agent: lean` header, or by setting
 * MERIDIAN_DEFAULT_AGENT=lean for instances that should serve only lean
 * traffic.
 *
 * Not equivalent to Anthropic's `tools: [{type: "web_search_20250305"}]`
 * server-side contract — the SDK's WebSearch / WebFetch built-ins fire
 * inside the agent loop and use whatever billing the SDK uses; typed tool
 * blocks in the request body are ignored. See PR description for context.
 */

import type { Context } from "hono"
import type { SettingSource } from "@anthropic-ai/claude-agent-sdk"
import type { AgentAdapter } from "../adapter"
import { normalizeContent } from "../messages"

const MCP_SERVER_NAME = "lean"

export const leanAdapter: AgentAdapter = {
  name: "lean",

  getSessionId(_c: Context): string | undefined {
    return undefined
  },

  extractWorkingDirectory(_body: any): string | undefined {
    return undefined
  },

  normalizeContent(content: any): string {
    return normalizeContent(content)
  },

  getMcpServerName(): string {
    return MCP_SERVER_NAME
  },

  getBlockedBuiltinTools(): readonly string[] {
    return [
      "Read", "Write", "Edit", "MultiEdit",
      "Bash", "Glob", "Grep", "NotebookEdit", "TodoWrite",
    ]
  },

  getAgentIncompatibleTools(): readonly string[] {
    return []
  },

  getAllowedMcpTools(): readonly string[] {
    return []
  },

  buildSdkAgents(_body: any, _mcpToolNames: readonly string[]): Record<string, any> {
    return {}
  },

  buildSdkHooks(_body: any, _sdkAgents: Record<string, any>): undefined {
    return undefined
  },

  buildSystemContextAddendum(_body: any, _sdkAgents: Record<string, any>): string {
    return ""
  },

  usesPassthrough(): boolean {
    return false
  },

  getSettingSources(): SettingSource[] {
    return []
  },

  prefersStreaming(body: any): boolean {
    return body?.stream === true
  },
}

import { leanTransforms } from "../transforms/lean"
export { leanTransforms }
