/**
 * Structured output via output_config.format (Anthropic-native).
 *
 * The /v1/messages endpoint accepts `output_config.format = {type, schema}`
 * per the public Claude API. The proxy threads it as `outputFormat` on the
 * Claude Agent SDK options, which carries it to the API. The SDK surfaces
 * the constrained generation as a synthetic `StructuredOutput` tool_use
 * block; the proxy unwraps that into a plain text block on the wire so
 * clients see clean JSON regardless of the SDK detail.
 *
 * Coverage:
 *   - /v1/messages: output_config.format threaded as outputFormat to SDK
 *   - /v1/messages: legacy response_format field is ignored (v1 shape removed)
 *   - non-streaming: StructuredOutput tool_use → single text block with JSON
 *   - streaming: content_block_start rewritten to type:text, input_json_delta
 *     → text_delta, message_delta stop_reason: tool_use → end_turn
 */

import { describe, it, expect, mock, beforeEach } from "bun:test"
import {
  messageStart,
  toolUseBlockStart,
  inputJsonDelta,
  blockStop,
  messageDelta,
  messageStop,
  assistantMessage,
  parseSSE,
} from "./helpers"

let mockMessages: unknown[] = []
let lastQueryOptions: Record<string, unknown> | null = null

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (params: { options?: Record<string, unknown> }) => {
    lastQueryOptions = params.options ?? null
    return (async function* () {
      for (const m of mockMessages) yield m
    })()
  },
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
  tool: () => ({}),
}))

mock.module("../logger", () => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: unknown, fn: () => unknown) => fn(),
}))

mock.module("../mcpTools", () => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }),
}))

const { createProxyServer, clearSessionCache } = await import("../proxy/server")

function createTestApp() {
  const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
  return app
}

const PERSON_SCHEMA = {
  type: "object",
  properties: { name: { type: "string" }, age: { type: "number" } },
  required: ["name", "age"],
  additionalProperties: false,
}

async function postNonStream(app: ReturnType<typeof createTestApp>, body: Record<string, unknown>) {
  return app.fetch(new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-5",
      max_tokens: 200,
      stream: false,
      messages: [{ role: "user", content: "Extract a person." }],
      ...body,
    }),
  }))
}

async function postStream(app: ReturnType<typeof createTestApp>, body: Record<string, unknown>) {
  const res = await app.fetch(new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-5",
      max_tokens: 200,
      stream: true,
      messages: [{ role: "user", content: "Extract a person." }],
      ...body,
    }),
  }))
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buf = ""
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
  }
  return parseSSE(buf)
}

// --------------------------------------------------------------------------
// SDK option threading: output_config.format → SDK outputFormat
// --------------------------------------------------------------------------

describe("/v1/messages: output_config threading", () => {
  beforeEach(() => {
    mockMessages = []
    lastQueryOptions = null
    clearSessionCache()
  })

  it("threads output_config.format as SDK outputFormat option", async () => {
    mockMessages = [assistantMessage([{ type: "text", text: "ok" }])]
    await postNonStream(createTestApp(), {
      output_config: { format: { type: "json_schema", schema: PERSON_SCHEMA } },
    })
    expect(lastQueryOptions).not.toBeNull()
    expect(lastQueryOptions!.outputFormat).toEqual({
      type: "json_schema",
      schema: PERSON_SCHEMA,
    })
  })

  it("does NOT set outputFormat when output_config is absent", async () => {
    mockMessages = [assistantMessage([{ type: "text", text: "ok" }])]
    await postNonStream(createTestApp(), {})
    expect(lastQueryOptions).not.toBeNull()
    expect(lastQueryOptions!.outputFormat).toBeUndefined()
  })

  it("ignores legacy response_format field (v1 shim removed)", async () => {
    mockMessages = [assistantMessage([{ type: "text", text: "ok" }])]
    await postNonStream(createTestApp(), {
      response_format: { type: "json_schema", schema: PERSON_SCHEMA },
    })
    expect(lastQueryOptions).not.toBeNull()
    expect(lastQueryOptions!.outputFormat).toBeUndefined()
  })

  it("ignores output_config.format with non-json_schema type", async () => {
    mockMessages = [assistantMessage([{ type: "text", text: "ok" }])]
    await postNonStream(createTestApp(), {
      output_config: { format: { type: "text", schema: PERSON_SCHEMA } },
    })
    expect(lastQueryOptions!.outputFormat).toBeUndefined()
  })

  it("ignores output_config.format missing schema", async () => {
    mockMessages = [assistantMessage([{ type: "text", text: "ok" }])]
    await postNonStream(createTestApp(), {
      output_config: { format: { type: "json_schema" } },
    })
    expect(lastQueryOptions!.outputFormat).toBeUndefined()
  })
})

// --------------------------------------------------------------------------
// Non-streaming: StructuredOutput tool_use → text block
// --------------------------------------------------------------------------

describe("/v1/messages non-stream: StructuredOutput unwrap", () => {
  beforeEach(() => {
    mockMessages = []
    lastQueryOptions = null
    clearSessionCache()
  })

  it("rewrites a StructuredOutput tool_use block as a text block with JSON.stringify(input)", async () => {
    const personJson = { name: "Ada", age: 36 }
    mockMessages = [assistantMessage([
      { type: "tool_use", id: "toolu_so_1", name: "StructuredOutput", input: personJson },
    ])]

    const res = await postNonStream(createTestApp(), {
      output_config: { format: { type: "json_schema", schema: PERSON_SCHEMA } },
    })
    const body = await res.json() as { content: Array<{ type: string; text?: string }>; stop_reason: string }

    expect(body.content).toHaveLength(1)
    expect(body.content[0]!.type).toBe("text")
    expect(body.content[0]!.text).toBe(JSON.stringify(personJson))
    expect(body.stop_reason).toBe("end_turn")
  })

  it("does not unwrap when output_config is absent (StructuredOutput passes through)", async () => {
    // Defensive: without output_config the unwrap path is a no-op. The block
    // would normally not exist in this case, but the proxy must not silently
    // rewrite arbitrary tool_use blocks.
    mockMessages = [assistantMessage([
      { type: "tool_use", id: "toolu_so_1", name: "StructuredOutput", input: { x: 1 } },
    ])]

    const res = await postNonStream(createTestApp(), {})
    const body = await res.json() as { content: Array<Record<string, unknown>> }

    expect(body.content).toHaveLength(1)
    expect(body.content[0]!.type).toBe("tool_use")
    expect(body.content[0]!.name).toBe("StructuredOutput")
  })
})

// --------------------------------------------------------------------------
// Streaming: rewrite StructuredOutput tool_use as text on the wire
// --------------------------------------------------------------------------

describe("/v1/messages stream: StructuredOutput unwrap", () => {
  beforeEach(() => {
    mockMessages = []
    lastQueryOptions = null
    clearSessionCache()
  })

  it("rewrites content_block_start StructuredOutput → type: text", async () => {
    mockMessages = [
      messageStart("msg_so_stream"),
      toolUseBlockStart(0, "StructuredOutput", "toolu_so_1"),
      inputJsonDelta(0, '{"name":"Ada"'),
      inputJsonDelta(0, ',"age":36}'),
      blockStop(0),
      messageDelta("tool_use"),
      messageStop(),
    ]

    const events = await postStream(createTestApp(), {
      output_config: { format: { type: "json_schema", schema: PERSON_SCHEMA } },
    })

    const blockStarts = events.filter((e) => e.event === "content_block_start")
    expect(blockStarts.length).toBe(1)
    const block = (blockStarts[0]!.data as Record<string, unknown>).content_block as Record<string, unknown>
    expect(block.type).toBe("text")
    expect(block.text).toBe("")
  })

  it("rewrites input_json_delta → text_delta and concatenated text equals the JSON payload", async () => {
    mockMessages = [
      messageStart("msg_so_stream"),
      toolUseBlockStart(0, "StructuredOutput", "toolu_so_1"),
      inputJsonDelta(0, '{"name":"Ada"'),
      inputJsonDelta(0, ',"age":36}'),
      blockStop(0),
      messageDelta("tool_use"),
      messageStop(),
    ]

    const events = await postStream(createTestApp(), {
      output_config: { format: { type: "json_schema", schema: PERSON_SCHEMA } },
    })

    const textDeltas = events.filter(
      (e) => e.event === "content_block_delta" &&
        ((e.data as Record<string, unknown>).delta as Record<string, unknown> | undefined)?.type === "text_delta"
    )
    expect(textDeltas.length).toBe(2)
    const concat = textDeltas
      .map((e) => ((e.data as Record<string, unknown>).delta as Record<string, unknown>).text as string)
      .join("")
    expect(concat).toBe('{"name":"Ada","age":36}')
    // And no leftover input_json_delta events:
    const inputJsonDeltas = events.filter(
      (e) => e.event === "content_block_delta" &&
        ((e.data as Record<string, unknown>).delta as Record<string, unknown> | undefined)?.type === "input_json_delta"
    )
    expect(inputJsonDeltas.length).toBe(0)
  })

  it("rewrites message_delta stop_reason: tool_use → end_turn when StructuredOutput was unwrapped", async () => {
    mockMessages = [
      messageStart("msg_so_stream"),
      toolUseBlockStart(0, "StructuredOutput", "toolu_so_1"),
      inputJsonDelta(0, '{"a":1}'),
      blockStop(0),
      messageDelta("tool_use"),
      messageStop(),
    ]

    const events = await postStream(createTestApp(), {
      output_config: { format: { type: "json_schema", schema: PERSON_SCHEMA } },
    })

    const msgDeltas = events.filter((e) => e.event === "message_delta")
    expect(msgDeltas.length).toBe(1)
    const stopReason = ((msgDeltas[0]!.data as Record<string, unknown>).delta as Record<string, unknown>).stop_reason
    expect(stopReason).toBe("end_turn")
  })

  it("does not rewrite stop_reason for non-StructuredOutput tool_use", async () => {
    // Sanity: when output_config is absent and a regular tool_use occurs, the
    // SDK's stop_reason should pass through unmodified (existing behavior).
    mockMessages = [
      messageStart("msg_regular"),
      toolUseBlockStart(0, "task", "toolu_task_1"),
      inputJsonDelta(0, '{"subagent_type":"explore","prompt":"x"}'),
      blockStop(0),
      messageDelta("tool_use"),
      messageStop(),
    ]

    const events = await postStream(createTestApp(), {})
    const msgDeltas = events.filter((e) => e.event === "message_delta")
    expect(msgDeltas.length).toBe(1)
    const stopReason = ((msgDeltas[0]!.data as Record<string, unknown>).delta as Record<string, unknown>).stop_reason
    expect(stopReason).toBe("tool_use")
  })
})
