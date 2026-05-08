import type { Transform, RequestContext } from "../transform"

const LEAN_BLOCKED_BUILTIN_TOOLS: readonly string[] = [
  "Read", "Write", "Edit", "MultiEdit",
  "Bash", "Glob", "Grep", "NotebookEdit", "TodoWrite",
]

export const leanTransforms: Transform[] = [
  {
    name: "lean-core",
    adapters: ["lean"],
    onRequest(ctx: RequestContext): RequestContext {
      return {
        ...ctx,
        blockedTools: LEAN_BLOCKED_BUILTIN_TOOLS,
        incompatibleTools: [],
        allowedMcpTools: [],
        sdkAgents: {},
        passthrough: false,
        settingSources: [],
        prefersStreaming: ctx.body?.stream === true,
      }
    },
  },
]
