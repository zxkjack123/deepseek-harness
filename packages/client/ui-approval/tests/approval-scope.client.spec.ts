import { Context } from '@deepseek-ai/cordis'
import { createScope, scopeOf } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply } from '../src/client/index.ts'
import { PendingApproval } from '../src/client/contract/slots.ts'

type ApprovalListener = (
  this: Context,
  request: {
    agent: Context
    toolName: string
    callId?: string
  },
  next: () => Promise<'unavailable'>,
) => Promise<unknown>

interface ScopeBench {
  readonly ctx: Context
  readonly listener: ApprovalListener
  readonly pending: PendingApproval[]
  readonly retain: ReturnType<typeof vi.fn>
  readonly release: ReturnType<typeof vi.fn>
  readonly scope: { fiber: { dispose(): Promise<void> } }
}

const id = (value: string): SessionId => value as SessionId

async function setupScopeBench(options: { resolve?: boolean } = {}): Promise<ScopeBench> {
  const ctx = new Context()
  let listener: ApprovalListener | undefined
  const pending: PendingApproval[] = []
  const release = vi.fn()
  const retain = vi.fn((sessionId: SessionId) => ({
    sessionId,
    release,
    ready: Promise.resolve(),
  }))
  ctx.provide('remote', {
    $on: (_event: string, callback: ApprovalListener) => {
      listener = callback
      return () => {}
    },
  } as never)
  ctx.provide('sessions', {
    scopeOf,
    ...(options.resolve === false ? {} : { retain }),
  } as never)
  ctx.provide('uiSession', {
    registerPendingInteraction: () => (value: PendingApproval) => {
      pending.push(value)
      return () => {}
    },
  } as never)
  ctx.provide('slots', {
    inject: (_name: string, mount: () => () => void) => {
      const dispose = ctx.effect(() => mount())
      return () => { void dispose() }
    },
    register: () => () => {},
    registerFactory: () => () => {},
  } as never)
  ctx.provide('shortcuts', { registerFixed: () => () => {} } as never)
  ctx.provide('locale', {
    bind: () => (key: string) => key,
    register: () => () => {},
    resolveText: () => 'reason',
  } as never)

  const fiber = ctx.plugin({ apply })
  await fiber.await()
  if (listener === undefined) throw new Error('approval listener was not registered')
  // The plugin fiber's own scope mints the answering generation below.
  const scope = createScope(ctx, id('s1'))
  await scope.fiber.await()
  return {
    ctx,
    listener,
    pending,
    retain,
    release,
    scope: { fiber: { dispose: async () => { await scope.fiber.dispose() } } },
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('approval Agent scope resolution', () => {
  it('publishes the card for a dispatch subject that carries its Agent scope', async () => {
    const bench = await setupScopeBench()
    const scoped = createScope(bench.ctx, id('s2'))
    await scoped.fiber.await()
    const next = vi.fn(() => Promise.resolve<'unavailable'>('unavailable'))
    const diagnostics = vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = bench.listener.call(scoped.ctx, { agent: scoped.ctx, toolName: 'bash', callId: 'call-1' }, next)

    expect(bench.pending).toHaveLength(1)
    expect(bench.pending[0]).toMatchObject({ kind: 'approval', sessionId: id('s2'), toolName: 'bash' })
    expect(bench.retain).not.toHaveBeenCalled()
    expect(diagnostics).not.toHaveBeenCalled()

    await bench.pending[0]!.answer('allowed-once')
    await expect(result).resolves.toBe('allowed-once')
    expect(next).not.toHaveBeenCalled()
    await scoped.fiber.dispose()
  })

  it('materializes the Agent scope named by the request and releases it after the answer', async () => {
    const bench = await setupScopeBench()
    const scoped = createScope(bench.ctx, id('s3'))
    await scoped.fiber.await()
    const next = vi.fn(() => Promise.resolve<'unavailable'>('unavailable'))
    const diagnostics = vi.spyOn(console, 'error').mockImplementation(() => {})

    // The dispatch subject is the untagged root; the request still names the Agent it answers for.
    const result = bench.listener.call(bench.ctx, { agent: scoped.ctx, toolName: 'write' }, next)

    expect(bench.pending).toHaveLength(1)
    expect(bench.pending[0]).toMatchObject({ sessionId: id('s3'), toolName: 'write' })
    expect(bench.retain).toHaveBeenCalledWith(id('s3'), { source: 'approval' })
    expect(diagnostics).not.toHaveBeenCalled()

    await bench.pending[0]!.answer('rejected')
    await expect(result).resolves.toBe('rejected')
    expect(bench.release).toHaveBeenCalledTimes(1)
    await scoped.fiber.dispose()
  })

  it('reports an approval request that reaches no Agent identity instead of dropping it silently', async () => {
    const bench = await setupScopeBench({ resolve: false })
    const next = vi.fn(() => Promise.resolve<'unavailable'>('unavailable'))
    const diagnostics = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(bench.listener.call(bench.ctx, { agent: bench.ctx, toolName: 'bash' }, next))
      .resolves.toBe('unavailable')

    expect(next).toHaveBeenCalledOnce()
    expect(bench.pending).toEqual([])
    expect(diagnostics).toHaveBeenCalledWith(
      '[ui-approval] approval request reached no Agent scope; delegating to the Host chain:',
      'bash',
    )
  })
})
