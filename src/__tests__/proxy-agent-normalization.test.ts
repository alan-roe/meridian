/**
 * Agent Type Normalization Tests
 *
 * Claude sometimes capitalizes agent names ("Explore" instead of "explore").
 * The proxy should normalize subagent_type to lowercase in task tool_use blocks
 * before forwarding to OpenCode.
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

let mockMessages: any[] = []

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: () => {
    return (async function* () {
      for (const msg of mockMessages) yield msg
    })()
  },
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
}))

mock.module("../logger", () => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: any, fn: any) => fn(),
}))

mock.module("../mcpTools", () => ({
  opencodeMcpServer: { type: "sdk", name: "opencode", instance: {} },
}))

const { createProxyServer } = await import("../proxy/server")

function createTestApp() {
  const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
  return app
}

async function postNonStream(app: any, body: any) {
  const req = new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "claude-sonnet-4-5", max_tokens: 1024, stream: false, ...body }),
  })
  return (await app.fetch(req)).json() as Promise<any>
}

async function postStream(app: any, body: any) {
  const req = new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "claude-sonnet-4-5", max_tokens: 1024, stream: true, ...body }),
  })
  const response = await app.fetch(req)
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let result = ""
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    result += decoder.decode(value, { stream: true })
  }
  return parseSSE(result)
}

describe("Agent type normalization: non-streaming", () => {
  beforeEach(() => { mockMessages = [] })

  it("should lowercase subagent_type in task tool_use blocks", async () => {
    mockMessages = [
      assistantMessage([
        { type: "tool_use", id: "toolu_1", name: "task", input: {
          subagent_type: "Explore",
          description: "Find files",
          prompt: "search src"
        }},
      ]),
    ]

    const app = createTestApp()
    const body = await postNonStream(app, {
      messages: [{ role: "user", content: "explore the code" }],
    })

    expect(body.content[0].type).toBe("tool_use")
    expect(body.content[0].input.subagent_type).toBe("explore")
  })

  it("should lowercase subagent_type with Tool name 'Task' (capitalized)", async () => {
    mockMessages = [
      assistantMessage([
        { type: "tool_use", id: "toolu_2", name: "Task", input: {
          subagent_type: "Oracle",
          description: "Consult",
          prompt: "analyze architecture"
        }},
      ]),
    ]

    const app = createTestApp()
    const body = await postNonStream(app, {
      messages: [{ role: "user", content: "consult oracle" }],
    })

    expect(body.content[0].input.subagent_type).toBe("oracle")
  })

  it("should handle hyphenated agent names", async () => {
    mockMessages = [
      assistantMessage([
        { type: "tool_use", id: "toolu_3", name: "task", input: {
          subagent_type: "Sisyphus-Junior",
          description: "Do work",
          prompt: "build feature"
        }},
      ]),
    ]

    const app = createTestApp()
    const body = await postNonStream(app, {
      messages: [{ role: "user", content: "build it" }],
    })

    expect(body.content[0].input.subagent_type).toBe("sisyphus-junior")
  })

  it("should not modify non-task tool_use blocks", async () => {
    mockMessages = [
      assistantMessage([
        { type: "tool_use", id: "toolu_4", name: "Read", input: {
          filePath: "README.md"
        }},
      ]),
    ]

    const app = createTestApp()
    const body = await postNonStream(app, {
      messages: [{ role: "user", content: "read readme" }],
    })

    expect(body.content[0].name).toBe("Read")
    expect(body.content[0].input.filePath).toBe("README.md")
  })

  it("should not modify already-lowercase agent names", async () => {
    mockMessages = [
      assistantMessage([
        { type: "tool_use", id: "toolu_5", name: "task", input: {
          subagent_type: "explore",
          description: "Search",
          prompt: "find files"
        }},
      ]),
    ]

    const app = createTestApp()
    const body = await postNonStream(app, {
      messages: [{ role: "user", content: "find files" }],
    })

    expect(body.content[0].input.subagent_type).toBe("explore")
  })
})

describe("Agent type normalization: streaming", () => {
  beforeEach(() => { mockMessages = [] })

  it("should lowercase subagent_type in streaming input_json_delta", async () => {
    // Simulate streaming a task tool_use with capitalized agent type
    mockMessages = [
      messageStart(),
      toolUseBlockStart(0, "task", "toolu_stream1"),
      inputJsonDelta(0, '{"subagent_type":"Explore"'),
      inputJsonDelta(0, ',"description":"Search"'),
      inputJsonDelta(0, ',"prompt":"find files"}'),
      blockStop(0),
      messageDelta("tool_use"),
      messageStop(),
    ]

    const app = createTestApp()
    const events = await postStream(app, {
      messages: [{ role: "user", content: "explore" }],
    })

    // Find the input_json_delta events for the task tool
    const jsonDeltas = events.filter(
      (e) => e.event === "content_block_delta" && (e.data as any).delta?.type === "input_json_delta"
    )

    // Reconstruct the full JSON from deltas
    const fullJson = jsonDeltas.map((e) => (e.data as any).delta.partial_json).join("")
    const parsed = JSON.parse(fullJson)
    expect(parsed.subagent_type).toBe("explore")
  })
})
