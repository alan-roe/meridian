/**
 * Unit tests for lineage hashing and verification functions.
 * These test the pure functions directly, without HTTP/SDK mocking.
 */
import { describe, it, expect } from "bun:test"
import {
  computeLineageHash,
  hashMessage,
  computeMessageHashes,
  measurePrefixOverlap,
  measureSuffixOverlap,
  verifyLineage,
  MIN_SUFFIX_FOR_COMPACTION,
  type SessionState,
} from "../proxy/session/lineage"

function msg(role: string, content: string) {
  return { role, content }
}

function makeSession(overrides: Partial<SessionState> = {}): SessionState {
  return {
    claudeSessionId: "sdk-1",
    lastAccess: Date.now(),
    messageCount: 0,
    lineageHash: "",
    ...overrides,
  }
}

const mockCache = { delete: () => true }

describe("computeLineageHash", () => {
  it("returns empty string for empty array", () => {
    expect(computeLineageHash([])).toBe("")
  })

  it("returns empty string for null/undefined", () => {
    expect(computeLineageHash(null as any)).toBe("")
    expect(computeLineageHash(undefined as any)).toBe("")
  })

  it("returns a 32-char hex hash", () => {
    const hash = computeLineageHash([msg("user", "hello")])
    expect(hash).toHaveLength(32)
    expect(hash).toMatch(/^[0-9a-f]{32}$/)
  })

  it("is deterministic", () => {
    const msgs = [msg("user", "hello"), msg("assistant", "hi")]
    expect(computeLineageHash(msgs)).toBe(computeLineageHash(msgs))
  })

  it("differs for different messages", () => {
    const a = computeLineageHash([msg("user", "hello")])
    const b = computeLineageHash([msg("user", "goodbye")])
    expect(a).not.toBe(b)
  })

  it("differs for different message order", () => {
    const a = computeLineageHash([msg("user", "a"), msg("assistant", "b")])
    const b = computeLineageHash([msg("assistant", "b"), msg("user", "a")])
    expect(a).not.toBe(b)
  })
})

describe("hashMessage", () => {
  it("returns a 32-char hex hash", () => {
    const hash = hashMessage(msg("user", "test"))
    expect(hash).toHaveLength(32)
    expect(hash).toMatch(/^[0-9a-f]{32}$/)
  })

  it("is deterministic", () => {
    const m = msg("user", "test")
    expect(hashMessage(m)).toBe(hashMessage(m))
  })

  it("differs by role", () => {
    expect(hashMessage(msg("user", "x"))).not.toBe(hashMessage(msg("assistant", "x")))
  })
})

describe("computeMessageHashes", () => {
  it("returns empty array for empty input", () => {
    expect(computeMessageHashes([])).toEqual([])
  })

  it("returns one hash per message", () => {
    const hashes = computeMessageHashes([msg("user", "a"), msg("assistant", "b")])
    expect(hashes).toHaveLength(2)
  })
})

describe("measurePrefixOverlap", () => {
  it("returns 0 for no overlap", () => {
    expect(measurePrefixOverlap(["a", "b"], new Set(["x", "y"]))).toBe(0)
  })

  it("counts consecutive prefix matches", () => {
    expect(measurePrefixOverlap(["a", "b", "c"], new Set(["a", "b"]))).toBe(2)
  })

  it("stops at first mismatch", () => {
    expect(measurePrefixOverlap(["a", "x", "b"], new Set(["a", "b"]))).toBe(1)
  })

  it("returns full length for complete match", () => {
    expect(measurePrefixOverlap(["a", "b"], new Set(["a", "b"]))).toBe(2)
  })
})

describe("measureSuffixOverlap", () => {
  it("returns 0 for no overlap", () => {
    expect(measureSuffixOverlap(["a", "b"], new Set(["x", "y"]))).toBe(0)
  })

  it("counts consecutive suffix matches", () => {
    expect(measureSuffixOverlap(["a", "b", "c"], new Set(["b", "c"]))).toBe(2)
  })

  it("stops at first mismatch from end", () => {
    expect(measureSuffixOverlap(["a", "x", "b"], new Set(["a", "b"]))).toBe(1)
  })
})

describe("verifyLineage", () => {
  it("returns continuation for empty lineage hash (legacy)", () => {
    const session = makeSession({ lineageHash: "", messageCount: 0 })
    const result = verifyLineage(session, [msg("user", "hi")], "key", mockCache)
    expect(result.type).toBe("continuation")
  })

  it("returns continuation when prefix matches exactly", () => {
    const msgs = [msg("user", "hello"), msg("assistant", "hi")]
    const session = makeSession({
      lineageHash: computeLineageHash(msgs),
      messageCount: msgs.length,
      messageHashes: computeMessageHashes(msgs),
    })
    // Same messages + one new one = valid continuation
    const extended = [...msgs, msg("user", "how are you?")]
    const result = verifyLineage(session, extended, "key", mockCache)
    expect(result.type).toBe("continuation")
  })

  it("returns diverged when no per-message hashes and lineage mismatches", () => {
    const session = makeSession({
      lineageHash: "abcd1234",
      messageCount: 2,
      messageHashes: undefined,
    })
    const result = verifyLineage(session, [msg("user", "different")], "key", mockCache)
    expect(result.type).toBe("diverged")
  })

  it("returns undo when prefix matches but suffix differs", () => {
    const msgs = [msg("user", "a"), msg("assistant", "b"), msg("user", "c"), msg("assistant", "d")]
    const hashes = computeMessageHashes(msgs)
    const session = makeSession({
      lineageHash: computeLineageHash(msgs),
      messageCount: msgs.length,
      messageHashes: hashes,
      sdkMessageUuids: [null, "uuid-1", null, "uuid-2"],
    })
    // Undo: keep first 2 messages, replace last 2
    const undone = [msg("user", "a"), msg("assistant", "b"), msg("user", "new")]
    const result = verifyLineage(session, undone, "key", mockCache)
    expect(result.type).toBe("undo")
    if (result.type === "undo") {
      expect(result.prefixOverlap).toBe(2)
      expect(result.rollbackUuid).toBe("uuid-1")
    }
  })

  it("returns compaction when suffix matches on long conversation", () => {
    // Need >= 6 stored messages and >= MIN_SUFFIX_FOR_COMPACTION suffix overlap
    const msgs = [
      msg("user", "a"), msg("assistant", "b"),
      msg("user", "c"), msg("assistant", "d"),
      msg("user", "e"), msg("assistant", "f"),
    ]
    const hashes = computeMessageHashes(msgs)
    const session = makeSession({
      lineageHash: computeLineageHash(msgs),
      messageCount: msgs.length,
      messageHashes: hashes,
    })
    // Compaction: change beginning, keep last MIN_SUFFIX_FOR_COMPACTION messages
    const compacted = [
      msg("user", "summary"), // replaced
      msg("user", "e"), msg("assistant", "f"), // preserved suffix
    ]
    const result = verifyLineage(session, compacted, "key", mockCache)
    expect(result.type).toBe("compaction")
  })
})
