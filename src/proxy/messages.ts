/**
 * Message parsing and normalization utilities.
 */

/**
 * Normalize message content to a string for hashing and comparison.
 * Handles both string content and array content (Anthropic content blocks).
 *
 * NOTE: OpenCode sends content as a string on the first request but as
 * an array on subsequent ones. This normalizer handles both formats.
 * Other agents may behave differently — this will move to the adapter pattern.
 */
export function normalizeContent(content: any): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content.map((block: any) => {
      if (block.type === "text" && block.text) return block.text
      if (block.type === "tool_use") return `tool_use:${block.id}:${block.name}:${JSON.stringify(block.input)}`
      if (block.type === "tool_result") return `tool_result:${block.tool_use_id}:${typeof block.content === "string" ? block.content : JSON.stringify(block.content)}`
      return JSON.stringify(block)
    }).join("\n")
  }
  return String(content)
}

/**
 * Extract only the last user message (for session resume — SDK already has history).
 */
export function getLastUserMessage(messages: Array<{ role: string; content: any }>): Array<{ role: string; content: any }> {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") return [messages[i]!]
  }
  return messages.slice(-1)
}
