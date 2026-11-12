import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { StreamChunk, UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { createSettlementMessage } from '@deepseek-ai/dsh-subagent/src/continuation-messages.ts'
import type { SubagentResult } from '@deepseek-ai/dsh-subagent'
import * as ChildFailureReminder from '@deepseek-ai/dsh-child-failure-reminder'
import type { Config } from '@deepseek-ai/dsh-child-failure-reminder'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

declare module '@deepseek-ai/dsh-subagent' {
  interface SubagentStopReasonMap {
    // A backend the guard's build does not know: treated as abnormal, not as success.
    'quota-exhausted': 'quota-exhausted'
  }
}

/**
 * Behavior suite for the child-failure guard: which settlements count as
 * abnormal, one reminder per settlement, the per-turn budget, the disposition
 * signal, and fail-loud config validation — all driven through a real agent
 * loop against a scripted mock adapter (no network).
 */

/** Boot the core spine + the guard; the caller registers adapters and extra listeners. */
async function harness(config: Config = {}): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(ChildFailureReminder, config)
  for (const name of ['subagent', 'send_message', 'probe']) {
    ctx.tools.register(defineContentToolFixture({
      name,
      description: name,
      parameters: {},
      async execute() { return [{ type: 'text', text: 'ok' }] },
    }))
  }
  return ctx
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: statusAgent, status }) => {
      if (statusAgent !== agent || status !== 'idle') return
      dispose()
      resolve()
    })
  })
}

/** Reminders this guard steered into the agent's log, flattened to their text and source. */
function reminders(agent: Agent): { text: string; source: unknown }[] {
  return agent.session.snapshotEvents()
    .filter((event): event is SessionEvent<'user/message'> =>
      event.type === 'user/message' && event.data.source.kind === 'child-failure-reminder')
    .map(event => ({
      text: event.data.content.map(block => block.type === 'text' ? block.text : '').join('|'),
      source: event.data.source,
    }))
}

/** The manager's own settlement notice for one child. */
function settlement(
  child: string,
  terminal: SubagentResult,
): ReturnType<typeof createSettlementMessage> {
  return createSettlementMessage(SessionId(child), child, terminal)
}

/** Boot one guarded agent whose model follows `script`, then deliver `notices` and wait for idle. */
async function run(
  script: StreamChunk[][],
  notices: UserMessage[],
  config: Config = {},
): Promise<{ ctx: Context; agent: Agent }> {
  const ctx = await harness(config)
  ctx.llm.registerAdapter(['mock'], new MockAdapter(script))
  const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
  for (const notice of notices) agent.steer(notice)
  await waitForIdle(ctx, agent)
  return { ctx, agent }
}

describe('which settlements are abnormal', () => {
  it('stays silent when the child completed', async () => {
    const { agent } = await run([textResponse('ack')], [
      settlement('worker', { output: [{ type: 'text', text: 'done' }], stopReason: 'completed' }),
    ])
    expect(reminders(agent)).toHaveLength(0)
  })

  it.each(['error', 'max-tokens', 'aborted', 'refusal'] as const)(
    'reminds once for a %s settlement',
    async (stopReason) => {
      const { agent } = await run([textResponse('ack'), textResponse('ack')], [
        settlement('worker', { output: [], stopReason }),
      ])
      const found = reminders(agent)
      expect(found).toHaveLength(1)
      expect(found[0]!.text).toContain(`Subagent "worker" did not finish its task (stopReason: ${stopReason}).`)
      expect(found[0]!.source).toEqual({ kind: 'child-failure-reminder', form: 'notice', summary: `worker: ${stopReason}` })
    },
  )

  it('treats a stop reason this build cannot name as abnormal', async () => {
    const { agent } = await run([textResponse('ack'), textResponse('ack')], [
      settlement('worker', { output: [], stopReason: 'quota-exhausted' }),
    ])
    expect(reminders(agent)).toHaveLength(1)
    expect(reminders(agent)[0]!.text).toContain('stopReason: quota-exhausted')
  })

  it('stays silent for a known reason the config leaves out', async () => {
    const { agent } = await run([textResponse('ack')], [
      settlement('worker', { output: [], stopReason: 'error' }),
    ], { stopReasons: ['max-tokens'] })
    expect(reminders(agent)).toHaveLength(0)
  })

  it('ignores a notice that records no stop reason', async () => {
    const notice = createUserMessage({
      content: [{ type: 'text', text: 'Background subagent worker finished.' }],
      source: { kind: 'subagent-settled', form: 'notice', summary: 'Background subagent worker finished.', senderSessionId: SessionId('c1') },
    })
    const { agent } = await run([textResponse('ack')], [notice])
    expect(reminders(agent)).toHaveLength(0)
  })
})

describe('the reminder', () => {
  it('quotes the diagnostic and the required actions', async () => {
    const { agent } = await run([textResponse('ack'), textResponse('ack')], [
      settlement('worker', { output: [], stopReason: 'error', diagnostic: 'PROVIDER_FAILURE: upstream 503' }),
    ])
    const text = reminders(agent)[0]!.text
    expect(text).toContain('Last line of its settlement notice: PROVIDER_FAILURE: upstream 503')
    expect(text).toContain('does not resolve it: act on it now')
    expect(text).toContain('re-dispatch with a smaller scope')
    expect(text).toContain('another preset, model, or provider')
    expect(text).toContain('[DELEGATION-FAILED: worker - <reason>]')
  })

  it('caps the quoted diagnostic at detailPreviewChars', async () => {
    const { agent } = await run([textResponse('ack'), textResponse('ack')], [
      settlement('worker', { output: [], stopReason: 'error', diagnostic: 'CODE: a message long enough to be cut' }),
    ], { detailPreviewChars: 10 })
    expect(reminders(agent)[0]!.text).toContain('Last line of its settlement notice: CODE: a me… (+27 more chars)')
  })

  it('omits the quoted line when the notice carries only its boilerplate closing', async () => {
    const { agent } = await run([textResponse('ack'), textResponse('ack')], [
      settlement('worker', { output: [], stopReason: 'max-tokens' }),
    ])
    const text = reminders(agent)[0]!.text
    expect(text).not.toContain('Last line of its settlement notice')
    expect(text).toContain('Subagent "worker" did not finish its task (stopReason: max-tokens).')
  })

  it('reads past non-text blocks when quoting the diagnostic', async () => {
    const notice = createUserMessage({
      content: [
        { type: 'text', text: 'Background subagent worker failed before it finished.' },
        { type: 'reasoning', text: 'internal reasoning' },
        { type: 'text', text: 'CODE: kept' },
      ],
      source: {
        kind: 'subagent-settled', form: 'notice', summary: 'Background subagent worker failed before it finished.',
        stopReason: 'error', senderSessionId: SessionId('c1'),
      },
    })
    const { agent } = await run([textResponse('ack'), textResponse('ack')], [notice])
    expect(reminders(agent)[0]!.text).toContain('Last line of its settlement notice: CODE: kept')
  })

  it('falls back to the child session id when the summary names no child', async () => {
    const notice = createUserMessage({
      content: [{ type: 'text', text: 'Something settled.' }, { type: 'text', text: 'CODE: broken' }],
      source: { kind: 'subagent-settled', form: 'notice', summary: 'Something settled.', stopReason: 'error', senderSessionId: SessionId('child-x') },
    })
    const { agent } = await run([textResponse('ack'), textResponse('ack')], [notice])
    expect(reminders(agent)[0]!.text).toContain('Subagent "child-x" did not finish its task')
    expect(reminders(agent)[0]!.text).toContain('[DELEGATION-FAILED: child-x - <reason>]')
  })
})

describe('reminder budget and disposition', () => {
  it('reminds once per settlement even when the model ends again without acting', async () => {
    const { agent } = await run([textResponse('I will look into it'), textResponse('I will look into it'), textResponse('I will look into it')], [
      settlement('worker', { output: [], stopReason: 'aborted' }),
    ])
    expect(reminders(agent)).toHaveLength(1)
  })

  it('caps steered reminders at maxPerTurn and stays silent past it', async () => {
    const { agent } = await run([textResponse('ack'), textResponse('ack'), textResponse('ack'), textResponse('ack')], [
      settlement('alpha', { output: [], stopReason: 'error' }),
      settlement('beta', { output: [], stopReason: 'aborted' }),
      settlement('gamma', { output: [], stopReason: 'refusal' }),
    ])
    expect(reminders(agent)).toHaveLength(2)
    expect(reminders(agent)[0]!.text).toContain('Subagent "alpha"')
    expect(reminders(agent)[1]!.text).toContain('Subagent "beta"')
  })

  it('honours a configured maxPerTurn of 1', async () => {
    const { agent } = await run([textResponse('ack'), textResponse('ack'), textResponse('ack')], [
      settlement('alpha', { output: [], stopReason: 'error' }),
      settlement('beta', { output: [], stopReason: 'aborted' }),
    ], { maxPerTurn: 1 })
    expect(reminders(agent)).toHaveLength(1)
  })

  it.each(['subagent', 'send_message'])('stays silent once the parent acted with %s', async (tool) => {
    const { agent } = await run([toolCallResponse('c1', tool, {}), textResponse('done')], [
      settlement('worker', { output: [], stopReason: 'error' }),
    ])
    expect(reminders(agent)).toHaveLength(0)
  })

  it('still reminds after an unrelated tool call', async () => {
    const { agent } = await run([toolCallResponse('c1', 'probe', {}), textResponse('done'), textResponse('done')], [
      settlement('worker', { output: [], stopReason: 'error' }),
    ])
    expect(reminders(agent)).toHaveLength(1)
  })

  it('does not carry an unhandled settlement into the next turn', async () => {
    const { ctx, agent } = await run([textResponse('ack'), textResponse('ack'), textResponse('ack')], [
      settlement('alpha', { output: [], stopReason: 'error' }),
      settlement('beta', { output: [], stopReason: 'aborted' }),
    ], { maxPerTurn: 1 })
    expect(reminders(agent)).toHaveLength(1)

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    expect(reminders(agent)).toHaveLength(1)
  })

  it('reminds when a child settles between the parent turns', async () => {
    const ctx = await harness()
    ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('first turn'), textResponse('ack'), textResponse('ack')]))
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    expect(reminders(agent)).toHaveLength(0)

    // Delivery after the parent already closed its turn wakes a new turn; the
    // settlement belongs to that turn, not to the one that had finished.
    agent.steer(settlement('worker', { output: [], stopReason: 'error' }))
    await waitForIdle(ctx, agent)
    expect(reminders(agent)).toHaveLength(1)
    expect(reminders(agent)[0]!.text).toContain('Subagent "worker" did not finish its task')
  })
})

describe('configuration validation', () => {
  const invalid: [string, Config][] = [
    ['an empty stopReasons list', { stopReasons: [] }],
    ['a blank stop reason', { stopReasons: ['error', ''] }],
    ['a zero maxPerTurn', { maxPerTurn: 0 }],
    ['a fractional maxPerTurn', { maxPerTurn: 1.5 }],
    ['a zero detailPreviewChars', { detailPreviewChars: 0 }],
    ['a fractional detailPreviewChars', { detailPreviewChars: 2.5 }],
    ['a blank disposition tool name', { dispositionTools: [''] }],
  ]

  it.each(invalid)('fails loud at load for %s', async (_label, config) => {
    await expect(harness(config)).rejects.toThrow('child-failure-reminder:')
  })
})

describe('unrelated events', () => {
  it('ignores a plain user message', async () => {
    const ctx = await harness()
    ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('done')]))
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    expect(reminders(agent)).toHaveLength(0)
  })
})
