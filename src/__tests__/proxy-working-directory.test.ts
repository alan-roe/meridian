/**
 * Working Directory Tests
 *
 * The proxy must pass the correct working directory to the Claude SDK
 * so that Claude's system prompt shows the user's project directory,
 * not the proxy's installation directory.
 *
 * Configurable via CLAUDE_PROXY_WORKDIR env var.
 */

import { describe, it, expect, mock, beforeEach, beforeAll, afterAll } from "bun:test"
import { mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assistantMessage } from "./helpers"

// Real existing dir on the test host — server-side spawn cwd must exist on
// this filesystem. See resolveSubprocessCwd in server.ts.
const TEST_WORKDIR = join(tmpdir(), "meridian-test-workdir-project")
beforeAll(() => mkdirSync(TEST_WORKDIR, { recursive: true }))
afterAll(() => rmSync(TEST_WORKDIR, { recursive: true, force: true }))

let mockMessages: any[] = []
let capturedQueryParams: any = null

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (params: any) => {
    capturedQueryParams = params
    return (async function* () {
      for (const msg of mockMessages) yield msg
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

function createTestApp() {
  const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
  return app
}

async function post(app: any, body: any) {
  const req = new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  return app.fetch(req)
}

describe("Working directory", () => {
  beforeEach(() => {
    mockMessages = [assistantMessage([{ type: "text", text: "Hi" }])]
    capturedQueryParams = null
    clearSessionCache()
  })

  it("should pass cwd option to the SDK query", async () => {
    const app = createTestApp()
    await (await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 100,
      stream: false,
      messages: [{ role: "user", content: "hello" }],
    })).json()

    expect(capturedQueryParams).toBeDefined()
    expect(capturedQueryParams.options.cwd).toBeDefined()
    expect(typeof capturedQueryParams.options.cwd).toBe("string")
  })

  it("should use CLAUDE_PROXY_WORKDIR when set", async () => {
    const original = process.env.CLAUDE_PROXY_WORKDIR
    process.env.CLAUDE_PROXY_WORKDIR = TEST_WORKDIR

    try {
      const app = createTestApp()
      await (await post(app, {
        model: "claude-sonnet-4-5",
        max_tokens: 100,
        stream: false,
        messages: [{ role: "user", content: "hello" }],
      })).json()

      expect(capturedQueryParams.options.cwd).toBe(TEST_WORKDIR)
    } finally {
      if (original) process.env.CLAUDE_PROXY_WORKDIR = original
      else delete process.env.CLAUDE_PROXY_WORKDIR
    }
  })

  it("falls back to process.cwd() when the client-reported cwd doesn't exist on this server", async () => {
    const original = process.env.CLAUDE_PROXY_WORKDIR
    // A path that will not exist on any test host
    process.env.CLAUDE_PROXY_WORKDIR = "/nonexistent/meridian-test/does-not-exist"

    try {
      const app = createTestApp()
      await (await post(app, {
        model: "claude-sonnet-4-5",
        max_tokens: 100,
        stream: false,
        messages: [{ role: "user", content: "hello" }],
      })).json()

      // The SDK subprocess must still be spawnable — fall back to process.cwd()
      expect(capturedQueryParams.options.cwd).toBe(process.cwd())
    } finally {
      if (original) process.env.CLAUDE_PROXY_WORKDIR = original
      else delete process.env.CLAUDE_PROXY_WORKDIR
    }
  })

  it("should default to process.cwd() when CLAUDE_PROXY_WORKDIR is not set", async () => {
    const original = process.env.CLAUDE_PROXY_WORKDIR
    delete process.env.CLAUDE_PROXY_WORKDIR

    try {
      const app = createTestApp()
      await (await post(app, {
        model: "claude-sonnet-4-5",
        max_tokens: 100,
        stream: false,
        messages: [{ role: "user", content: "hello" }],
      })).json()

      expect(capturedQueryParams.options.cwd).toBe(process.cwd())
    } finally {
      if (original) process.env.CLAUDE_PROXY_WORKDIR = original
    }
  })
})
