/**
 * Per-delegation reasoning effort for `ctx.subagents` children.
 *
 * Closes one gap end to end: `@deepseek-ai/dsh-tool-subagent` accepts
 * config-level `agentOptions` and forwards them into the child's
 * `AgentOptions`, but the agent loop's request builder only reads
 * `provider`/`model`/`maxTokens` from `AgentOptions` — a `reasoningEffort`
 * declared there was silently ignored (the model never saw it, no error).
 *
 * Two layers fix that:
 *
 * 1. **Effort plumbing** — this package extends the merge-extensible
 *    `AgentOptions` interface with `reasoningEffort` and injects it into every
 *    request of that agent through the `agent/request` waterfall. Config-level
 *    effort (e.g. `tool-subagent`'s `agentOptions`) now reaches the adapter.
 * 2. **Per-call tool** — registers `subagent_effort` (configurable name), a
 *    foreground subagent tool that accepts `reasoning_effort` (`off` | `low` |
 *    `high` | `max`, the DeepSeek adapter vocabulary) and an optional `model`
 *    override per call, forwarded as child `agentOptions`.
 *
 * @module @argszero/cordis-plugin-subagent-effort
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import type { LlmCallConfig, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { SubagentResult, SubagentRun } from '@deepseek-ai/dsh-subagent'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-subagent'

declare module '@deepseek-ai/dsh-agent' {
  interface AgentOptions {
    /** Thinking effort for every request of this agent; injected by this plugin's `agent/request` listener. */
    reasoningEffort?: ReasoningEffortId
  }
}

export const name = 'subagent-effort'
export const inject = ['tools', 'subagents']

/** Plugin configuration. */
export interface Config {
  /** The `ctx.subagents` provider name to delegate on (e.g. `spawn`, `fork`, `acp`). */
  provider: string
  /** Model-facing tool name (default `subagent_effort`). */
  toolName?: string
  /** Effort applied when a call omits `reasoning_effort`. */
  defaultReasoningEffort?: 'off' | 'low' | 'high' | 'max'
}

export const Config: z<Config> = z.object({
  provider: z.string().required(),
  toolName: z.string().default('subagent_effort'),
  defaultReasoningEffort: z.union(['off', 'low', 'high', 'max']),
})

/** The DeepSeek adapter's accepted reasoning-effort vocabulary. */
export const REASONING_EFFORTS = ['off', 'low', 'high', 'max'] as const
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number]

function effortId(effort: ReasoningEffort): ReasoningEffortId {
  return effort as ReasoningEffortId
}

/**
 * Inject a child's declared `reasoningEffort` into every request it makes.
 * Only agents whose options explicitly carry the field are touched; the
 * resolved config is otherwise passed through untouched.
 */
function installEffortInjection(ctx: Context): void {
  ctx.on('agent/request', async (payload, next): Promise<LlmCallConfig> => {
    const resolved = await next()
    const effort = payload.agent.options.reasoningEffort
    if (effort === undefined) return resolved
    return { ...resolved, reasoningEffort: effort }
  })
}

/** The canonical foreground result shape shared with `@deepseek-ai/dsh-tool-subagent`. */
type ForegroundToolResult = {
  readonly kind: 'foreground'
  readonly runId: SubagentRun['id']
  readonly output: JsonValue[]
}

/** A non-`completed` stop reason means the child did not finish cleanly. */
function stopReasonError(result: SubagentResult): string | undefined {
  switch (result.stopReason) {
    case 'completed':
      return undefined
    case 'aborted':
      return 'subagent run was cancelled'
    case 'error':
      return 'subagent run failed'
    case 'max-tokens':
      return 'subagent run hit its token limit before finishing'
    case 'refusal':
      return 'subagent declined the task'
    default:
      return `subagent run ended abnormally (${String(result.stopReason)})`
  }
}

/** Collect and release one foreground run without letting disposal mask a result failure. */
async function settleForeground(run: SubagentRun): Promise<ForegroundToolResult> {
  const [execution] = await Promise.allSettled([
    run.result.then((result): ForegroundToolResult => {
      const error = stopReasonError(result)
      if (error !== undefined) throw new Error(error)
      return {
        kind: 'foreground',
        runId: run.id,
        output: result.output as unknown as JsonValue[],
      }
    }),
  ])
  const [disposal] = await Promise.allSettled([Promise.resolve().then(() => run.dispose())])
  if (execution.status === 'rejected') {
    if (disposal.status === 'rejected') {
      throw new AggregateError(
        [execution.reason, disposal.reason],
        `subagent run failed: ${String(execution.reason)}; dispose failed: ${String(disposal.reason)}`,
      )
    }
    throw execution.reason
  }
  if (disposal.status === 'rejected') throw disposal.reason
  return execution.value
}

interface ToolArgs {
  readonly description: string
  readonly prompt: string
  readonly reasoning_effort?: ReasoningEffort
  readonly model?: string
}

/** Register the model-facing per-call effort tool; returns the disposer. */
function mountTool(ctx: Context, config: Config): () => void {
  const toolName = config.toolName ?? 'subagent_effort'
  const defaultEffort = config.defaultReasoningEffort
  return ctx.tools.register(defineTool({
    name: toolName,
    description: 'Delegate a task to a subagent with an explicit reasoning effort. Use this when the subtask needs a specific thinking budget (e.g. `max` for a hard analysis, `low` for a mechanical lookup) or a different model than your own. The call waits for the subagent and returns its result.',
    parameters: {
      description: {
        type: 'string',
        required: true,
        description: 'A short (3-5 word) description of the delegated task, for display.',
      },
      prompt: {
        type: 'string',
        required: true,
        description: 'The full task to delegate. Be specific: state the expected output and any constraints.',
      },
      reasoning_effort: {
        type: 'string',
        enum: [...REASONING_EFFORTS],
        description: `Thinking effort for this delegation (${REASONING_EFFORTS.join(', ')}). Defaults to the configured default or the provider default.`,
      },
      model: {
        type: 'string',
        description: 'Provider model override for this delegation.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true, const: 'foreground' },
          runId: { type: 'string', required: true },
          output: { type: 'array', required: true, items: { type: 'json' } },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.kind === 'foreground'
          ? `subagent ${value.runId} returned ${value.output.length} block(s)`
          : String(value.kind),
      }],
    },
    isConcurrencySafe: () => true,
    async execute(args: ToolArgs, exec) {
      const parent = exec.agent
      if (!parent) {
        throw new Error(`${toolName} requires a calling agent (exec.agent was undefined)`)
      }
      const effort = args.reasoning_effort ?? defaultEffort
      const agentOptions: AgentOptions = {
        ...(effort === undefined ? {} : { reasoningEffort: effortId(effort) }),
        ...(args.model === undefined ? {} : { model: args.model }),
      }
      const run: SubagentRun = await ctx.subagents.start(config.provider, {
        label: args.description,
        prompt: [{ type: 'text', text: args.prompt }],
        parent,
        ...(Object.keys(agentOptions).length > 0 ? { agentOptions } : {}),
        signal: exec.signal,
      })
      return settleForeground(run)
    },
  }))
}

export function apply(ctx: Context, config: Config): void {
  installEffortInjection(ctx)

  // Mirror the provider lifecycle of @deepseek-ai/dsh-tool-subagent: register
  // the tool when the configured provider appears, and unregister when it
  // leaves, so a late-arriving provider still gets the tool.
  let disposeTool: (() => void) | undefined
  const mount = (): void => {
    disposeTool = mountTool(ctx, config)
  }
  ctx.on('subagent/provider-added', (provider) => {
    if (provider.name === config.provider && disposeTool === undefined) mount()
  })
  ctx.on('subagent/provider-removed', (name) => {
    if (name !== config.provider || disposeTool === undefined) return
    disposeTool()
    disposeTool = undefined
  })
  const present = ctx.subagents.getProvider(config.provider)
  if (present !== undefined) {
    mount()
  } else {
    ctx.logger.info(
      `subagent provider "${config.provider}" not registered yet; the "${toolName(config)}" tool will register when it appears`,
    )
  }
}

function toolName(config: Config): string {
  return config.toolName ?? 'subagent_effort'
}
