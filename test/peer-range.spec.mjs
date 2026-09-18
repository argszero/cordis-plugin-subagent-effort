import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { satisfies } from 'semver'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

/** Published @deepseek-ai/dsh-* versions, oldest first, frozen 2026-09-18. */
const PUBLISHED = [
  '0.0.1-rc.1', '0.0.1-rc.2', '0.0.1-rc.3', '0.0.1-rc.5',
  '0.1.0-rc.2', '0.1.0-rc.3', '0.1.0-rc.6', '0.1.0-rc.7', '0.1.0-rc.8',
  '0.1.1-rc.1', '0.1.1-rc.2',
  '0.1.2-alpha.2', '0.1.2-alpha.3', '0.1.2-alpha.4', '0.1.2-alpha.5',
  '0.1.2-rc.1',
  '0.1.3-alpha.2',
  '0.1.5-alpha.1', '0.1.5-alpha.2', '0.1.5-rc.1', '0.1.5-rc.2',
  '0.1.6-alpha.1', '0.1.6-alpha.2',
]

/**
 * The one dsh line this plugin targets. Upstream closed the gap it exists to
 * fill in 0.1.2-alpha.1 (`AgentOptions.reasoningEffort` is consumed natively
 * from there), so the plugin is deliberately scoped to the line where the gap
 * still exists - dsh 0.1.1-rc.2. That is a scope decision, not an oversight.
 */
const SUPPORTED = ['0.1.1-rc.2']

const DSH = [
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-subagent',
  '@deepseek-ai/dsh-tools',
]

/**
 * Harness packages are PEERS, never dependencies.
 *
 * v0.1.0 declared these five as `dependencies` at `^0.1.1-rc.2`. A caret on a
 * prerelease admits only its own tuple, so no newer tree can satisfy it - and
 * npm resolves an unsatisfiable *dependency* by nesting its own copy. Measured
 * against the published 0.1.0 in a project running dsh 0.1.6-alpha.2:
 *
 *   node_modules/@argszero/cordis-plugin-subagent-effort/node_modules/@deepseek-ai/dsh-tools  (=0.1.1-rc.2)
 *   node_modules/@deepseek-ai/dsh-tools                                                       (=0.1.6-alpha.2)
 *
 * Two copies of the harness runtime in one process, silently. The declared
 * scope was already too narrow for that tree; as a *dependency* the mismatch
 * produced a working install with a broken runtime, and as a *peer* it produces
 * a loud ERESOLVE instead - which is the correct outcome for a plugin that does
 * not target the user's dsh line.
 */
test('no @deepseek-ai/dsh-* package is declared as a dependency', () => {
  const leaked = Object.keys(pkg.dependencies ?? {}).filter((d) =>
    d.startsWith('@deepseek-ai/dsh-'),
  )
  assert.deepEqual(
    leaked,
    [],
    `harness packages must be peers so npm cannot nest a second copy: ${leaked.join(', ')}`,
  )
})

for (const dep of DSH) {
  test(`peer range for ${dep} admits exactly the targeted dsh line`, () => {
    const range = pkg.peerDependencies[dep]
    assert.ok(range, 'the dsh peer dependency must be declared')

    const admitted = PUBLISHED.filter((v) => satisfies(v, range))
    assert.deepEqual(
      admitted,
      SUPPORTED,
      `the range "${range}" admits [${admitted.join(', ')}] but this plugin only targets ` +
        `[${SUPPORTED.join(', ')}]`,
    )
  })
}

test('the range is stated explicitly rather than as a caret on a prerelease', () => {
  // `^0.1.1-rc.2` happens to be equivalent today, but it does not read as though
  // it were scoped to one tuple - and the tuple rule is what makes it narrow.
  for (const dep of DSH) {
    const range = pkg.peerDependencies[dep]
    assert.ok(!range.startsWith('^'), `"${range}" hides the tuple scope behind a caret`)
    assert.match(range, /<0\.1\.2/, `"${range}" should name its tuple's upper bound`)
  }
})

test('newer dsh lines are refused, so an unsupported install fails loudly', () => {
  // The plugin is superseded from 0.1.2-alpha.1; a user there should be told by
  // npm, not handed a second copy of the runtime.
  for (const dep of DSH) {
    for (const line of ['0.1.3-alpha.2', '0.1.6-alpha.2']) {
      assert.equal(
        satisfies(line, pkg.peerDependencies[dep]),
        false,
        `${dep} must refuse ${line} - the gap is fixed upstream on that line`,
      )
    }
  }
})

test('the dev pins stay on a line the range admits', () => {
  for (const [dep, pin] of Object.entries(pkg.devDependencies ?? {})) {
    if (!dep.startsWith('@deepseek-ai/dsh-')) continue
    assert.ok(SUPPORTED.includes(pin), `devDependency ${dep}@"${pin}" is not in the targeted set`)
  }
})

test('the README quotes the manifest peer range verbatim', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  for (const dep of DSH) {
    const range = pkg.peerDependencies[dep]
    assert.ok(readme.includes(range), `README must quote the exact peer range: "${range}"`)
  }
})
