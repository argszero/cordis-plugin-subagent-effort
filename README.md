# @argszero/cordis-plugin-subagent-effort

Per-delegation reasoning effort for [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) subagents.

> ## ⚠️ Superseded upstream (0.1.2-alpha.1, 2026-08-28)
>
> deepseek-harness **0.1.2-alpha.1 fixed this gap natively**: `AgentOptions` now
> carries `reasoningEffort` (consumed by the agent-loop request builder), and
> `dsh-tool-subagent` exposes a per-call `reasoning_effort` parameter plus
> background/continuable delegation. This plugin is **not needed on
> ≥ 0.1.2-alpha.1** and is kept for users pinned to `0.1.1-rc.2`, where the
> silent-drop gap still exists. See
> [discussion #4666](https://github.com/deepseek-ai/deepseek-harness/discussions/4666)
> for the maintainer-confirmed root cause and the upstream fix.

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

## Peer range

This plugin targets one dsh line, and declares every harness package it reads as
a **peer** rather than a dependency:

```
>=0.1.1-rc.2 <0.1.2
```

declared identically on `@deepseek-ai/dsh-agent`, `@deepseek-ai/dsh-llm`,
`@deepseek-ai/dsh-session`, `@deepseek-ai/dsh-subagent` and
`@deepseek-ai/dsh-tools`. It admits exactly `0.1.1-rc.2`.

The narrow scope is deliberate: upstream closed this gap natively in
**0.1.2-alpha.1** (`AgentOptions.reasoningEffort` is consumed from there), so the
plugin is only meaningful on the line where the silent drop still exists.

The *declaration* was the bug. v0.1.0 shipped these five as `dependencies` at
`^0.1.1-rc.2`, and a caret on a prerelease admits only its own tuple — so no
newer tree could satisfy it, and npm resolves an unsatisfiable *dependency* by
nesting its own copy. Installing the published 0.1.0 into a project running dsh
`0.1.6-alpha.2` produced:

```
node_modules/@argszero/cordis-plugin-subagent-effort/node_modules/@deepseek-ai/dsh-tools   (=0.1.1-rc.2)
node_modules/@deepseek-ai/dsh-tools                                                        (=0.1.6-alpha.2)
```

Two copies of the harness runtime in one process, with no warning at all. As a
**peer** the same narrow scope produces the correct outcome instead: npm refuses
the install with `ERESOLVE`, which tells a user on a newer line that this plugin
is not for them.

`test/peer-range.spec.mjs` asserts the admitted set exactly, asserts that no
harness package appears in `dependencies`, and asserts that this README quotes
the manifest range verbatim.

## Development

```sh
npm install
npm run build        # tsc → lib/
npm test             # tsc + node --test (peer-range / declaration guard)
```

## License

MIT
