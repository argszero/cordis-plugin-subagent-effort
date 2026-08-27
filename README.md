# @argszero/cordis-plugin-subagent-effort

Per-delegation reasoning effort for [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) subagents.

Closes one gap end to end: `@deepseek-ai/dsh-tool-subagent` accepts config-level
`agentOptions` and forwards them into the child's `AgentOptions`, but the agent
loop's request builder only reads `provider` / `model` / `maxTokens` from
`AgentOptions` — a `reasoningEffort` declared there was **silently ignored**
(the model never saw it, no error). This plugin fixes the consumption side and
adds a per-call effort tool.

## What it does

1. **Effort plumbing** — extends the merge-extensible `AgentOptions` interface
   with `reasoningEffort` and injects it into every request of that agent via
   the `agent/request` waterfall. Config-declared effort (e.g. `tool-subagent`'s
   `agentOptions.reasoningEffort`) now actually reaches the adapter.
2. **Per-call tool** — registers `subagent_effort` (configurable), a foreground
   subagent tool accepting `reasoning_effort` (`off` | `low` | `high` | `max`,
   the DeepSeek adapter vocabulary) and an optional `model` override per call,
   forwarded as child `agentOptions`.

## Install

```sh
# add to your dsh profile (the dsh.bundle declaration mounts it as a profile layer)
pnpm add @argszero/cordis-plugin-subagent-effort
```

Set the provider in your profile's `cordis.patch.yml` (last write wins per row):

```yaml
- set:
    - id: subagent-effort
      config:
        provider: spawn          # your ctx.subagents provider name
        # toolName: subagent_effort
        # defaultReasoningEffort: high
```

## Config

| key | type | default | meaning |
|-----|------|---------|---------|
| `provider` | string | — (required) | the `ctx.subagents` provider name to delegate on (e.g. `spawn`, `fork`, `acp`) |
| `toolName` | string | `subagent_effort` | model-facing tool name |
| `defaultReasoningEffort` | `'off' \| 'low' \| 'high' \| 'max'` | provider default | effort applied when a call omits `reasoning_effort` |

## Usage

### Config-level effort (fixes the silent drop)

With `@deepseek-ai/dsh-tool-subagent` configured with `agentOptions`, the
effort now reaches the child's requests:

```yaml
- set:
    - id: subagent
      config:
        provider: spawn
        agentOptions:
          reasoningEffort: high
```

Without this plugin that value was accepted and silently ignored.

### Per-call effort (new tool)

The `subagent_effort` tool lets the model vary the thinking budget per
delegation:

```
{
  "description": "verify the proof",
  "prompt": "Check the induction step carefully…",
  "reasoning_effort": "max"
}
```

Optional `model` overrides the child's model for that delegation.

## Design notes

- The tool mirrors `@deepseek-ai/dsh-tool-subagent`'s provider lifecycle: it
  registers when the configured provider appears and unregisters when it leaves.
- The `agent/request` listener is conservative: only agents whose options
  explicitly carry `reasoningEffort` are touched; every other request passes
  through unchanged.
- Foreground-only by design — background/continuable delegation is available
  from the built-in `subagent` tool; this plugin is about effort control.

## Development

```sh
npm install
npm run build        # tsc → lib/
node smoke.mjs       # loads the plugin on a real Cordis context and verifies
                     # tool registration, request injection, and option forwarding
```

## License

MIT
