/**
 * Non-streaming result-event usage accounting.
 *
 * The SDK can emit multiple `type: "assistant"` events per request (tool-call
 * turns, internal syntheses, end-of-turn acknowledgements). Each carries its
 * own per-segment `usage`. A shallow merge across them produces Frankenstein
 * totals: the final tiny event overwrites real output_tokens, while fields
 * only reported in the first event (e.g. cache_creation_input_tokens) persist.
 *
 * The SDK also emits a terminal `type: "result"` event whose `usage` field
 * is the canonical cumulative total. Verify we prefer it over merged
 * per-assistant values.
 */

import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test"

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: () => {
    return (async function* () {
      // First turn: real work.
      yield {
        type: "assistant",
        message: {
          id: "msg_1",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "hello there" }],
          model: "claude-sonnet-4-5",
          stop_reason: "end_turn",
          usage: {
            input_tokens: 10,
            output_tokens: 500,
            cache_creation_input_tokens: 10_000,
            cache_read_input_tokens: 0,
          },
        },
        session_id: "sess-1",
      }
      // Second event: end-of-turn synthesis with tiny counters.
      // Without the fix, shallow-merging this clobbers output_tokens=500
      // while leaving cache_creation_input_tokens stuck at 10000.
      yield {
        type: "assistant",
        message: {
          id: "msg_2",
          type: "message",
          role: "assistant",
          content: [],
          model: "claude-sonnet-4-5",
          stop_reason: "end_turn",
          usage: { input_tokens: 3, output_tokens: 8 },
        },
        session_id: "sess-1",
      }
      // Canonical cumulative totals.
      yield {
        type: "result",
        subtype: "success",
        duration_ms: 100,
        duration_api_ms: 80,
        is_error: false,
        num_turns: 1,
        result: "hello there",
        stop_reason: "end_turn",
        total_cost_usd: 0,
        usage: {
          input_tokens: 13,
          output_tokens: 508,
          cache_creation_input_tokens: 10_000,
          cache_read_input_tokens: 0,
        },
        modelUsage: {},
        permission_denials: [],
        uuid: "uuid-result",
        session_id: "sess-1",
      }
    })()
  },
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
  tool: () => ({}),
}))

mock.module("../logger", () => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: any, fn: any) => fn(),
}))

mock.module("../mcpTools", () => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }),
}))

const { createProxyServer, clearSessionCache } = await import("../proxy/server")

let savedPassthrough: string | undefined

describe("non-stream result-event usage", () => {
  beforeEach(() => {
    savedPassthrough = process.env.MERIDIAN_PASSTHROUGH
    process.env.MERIDIAN_PASSTHROUGH = "0"
    clearSessionCache()
  })

  afterEach(() => {
    if (savedPassthrough !== undefined) process.env.MERIDIAN_PASSTHROUGH = savedPassthrough
    else delete process.env.MERIDIAN_PASSTHROUGH
  })

  it("prefers the terminal result event's usage over merged per-assistant usage", async () => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
    const res = await app.fetch(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 1024,
        stream: false,
        messages: [{ role: "user", content: "hi" }],
      }),
    }))
    const body = await res.json() as { usage: Record<string, number> }

    expect(body.usage.output_tokens).toBe(508)
    expect(body.usage.input_tokens).toBe(13)
    expect(body.usage.cache_creation_input_tokens).toBe(10_000)
    expect(body.usage.cache_read_input_tokens).toBe(0)
  })
})
