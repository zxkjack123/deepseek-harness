/** Cards rebuilt from the `approvalState` projection, and their one-card-per-ask rule. */
import { Context } from '@deepseek-ai/cordis'
import { createScope, scopeOf } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ApprovalRequestId, PendingApprovalView } from '@deepseek-ai/dsh-user-approval/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PendingApproval } from '../src/client/contract/slots.ts'
import { apply, inject } from '../src/client/index.ts'
import { ApprovalCards } from '../src/client/restore.ts'

const SESSION_ID = 's1' as SessionId
const ASK = 'ask-1' as ApprovalRequestId

/** Minimal observable snapshot source, the shape the Session projections expose. */
function snapshotOf<T>(initial: T) {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: (): T => value,
    subscribers: (): number => listeners.size,
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set: (next: T): void => {
      value = next
      for (const listener of [...listeners]) listener()
    },
  }
}

type ApprovalListener = (
  this: Context,
  request: { requestId?: ApprovalRequestId; toolName: string; callId?: string; reason?: string; signal?: AbortSignal },
  next: () => Promise<'unavailable'>,
) => Promise<unknown>

async function bench(active: readonly PendingApprovalView[] = []) {
  const ctx = new Context()
  const approvals = snapshotOf<readonly PendingApprovalView[] | undefined>(active)
  const list = snapshotOf({
    ids: [SESSION_ID],
    byId: { [SESSION_ID]: { id: SESSION_ID } },
    phase: 'ready' as const,
    subagentsByParent: {},
    jobsBySession: {},
    currentAddress: undefined,
  })
  const binding = vi.fn((sessionId: SessionId) => sessionId === SESSION_ID
    ? { sessionId, session: { projections: { faceOf: (name: string) => name === 'approvalState' ? approvals : undefined } } }
    : undefined)
  ctx.provide('sessions', { scopeOf, list, binding } as never)
  const answerLate = vi.fn(async (
    _sessionId: SessionId, _id: ApprovalRequestId, _decision: string,
  ): Promise<{ ok: true; value: undefined } | { ok: false; error: { code: string; message: string } }> => (
    { ok: true, value: undefined }
  ))
  ctx.provide('remote.approval', { answerLate } as never)
  let listener: ApprovalListener | undefined
  ctx.provide('remote', {
    $on: (_event: string, callback: ApprovalListener) => {
      listener = callback
      return () => {}
    },
    approval: { answerLate },
  } as never)
  const pending = new Map<PendingApproval, () => Promise<void>>()
  const registerPendingInteraction = vi.fn((_precedence: (value: PendingApproval) => number) => (
    value: PendingApproval,
    delegate: () => Promise<void>,
  ) => {
    pending.set(value, delegate)
    return () => { pending.delete(value) }
  })
  ctx.provide('uiSession', { registerPendingInteraction } as never)
  ctx.provide('slots', { inject: vi.fn(() => () => {}), register: vi.fn(() => () => {}), registerFactory: vi.fn() } as never)
  ctx.provide('shortcuts', { registerFixed: vi.fn(() => () => {}) } as never)
  ctx.provide('locale', {
    bind: () => (key: string) => `copy:${key}`,
    register: vi.fn(() => () => {}),
    resolveText: (reason: { en: string }) => reason.en,
  } as never)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return {
    ctx,
    approvals,
    list,
    answerLate,
    cards: { getSnapshot: () => [...pending.keys()] },
    listener: () => {
      if (listener === undefined) throw new Error('approval listener was not installed')
      return listener
    },
  }
}

const ask = (overrides: Partial<PendingApprovalView> = {}): PendingApprovalView => ({
  id: ASK,
  toolName: 'bash',
  ...overrides,
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('restored approvals', () => {
  it('presents an answerable card for a request only the log knows', async () => {
    const b = await bench([ask({ callId: 'call-1' as ToolCallId, reason: 'needs access' })])

    const pending = b.cards.getSnapshot()[0]
    expect(pending).toMatchObject({
      kind: 'approval',
      sessionId: SESSION_ID,
      requestId: ASK,
      toolName: 'bash',
      callId: 'call-1',
      reason: 'needs access',
    })
    expect(pending?.key).toBe('approval:s1:ask-1')
    expect(pending?.answerable).toBe(true)
    await b.ctx.fiber.dispose()
  })

  it('answers a restored card through the late-answer entry and clears it', async () => {
    const b = await bench([ask()])
    const pending = b.cards.getSnapshot()[0]!

    await pending.answer('allowed-once')

    expect(b.answerLate).toHaveBeenCalledExactlyOnceWith(SESSION_ID, ASK, 'allowed-once')
    await expect(pending.result).resolves.toBe('allowed-once')
    expect(b.cards.getSnapshot()).toEqual([])
    await b.ctx.fiber.dispose()
  })

  it('removes the card once the projection stops listing the request', async () => {
    const b = await bench([ask()])
    expect(b.cards.getSnapshot()).toHaveLength(1)

    b.approvals.set([])

    expect(b.cards.getSnapshot()).toEqual([])
    await b.ctx.fiber.dispose()
  })

  it('keeps a refused late answer on the card so the user can retry', async () => {
    const b = await bench([ask()])
    b.answerLate.mockResolvedValueOnce({
      ok: false,
      error: { code: 'gateway/internal', message: 'carrier closed' },
    })
    const pending = b.cards.getSnapshot()[0]!

    await expect(pending.answer('rejected')).rejects.toThrow(/gateway\/internal/)

    expect(pending.answerable).toBe(true)
    expect(b.cards.getSnapshot()).toEqual([pending])
    await b.ctx.fiber.dispose()
  })

  it('lets a live waterfall ride the card the projection already presented', async () => {
    const b = await bench([ask()])
    const restored = b.cards.getSnapshot()[0]!
    const scope = createScope(b.ctx, SESSION_ID)
    await scope.fiber.await()
    const next = vi.fn(() => Promise.resolve<'unavailable'>('unavailable'))

    const result = b.listener().call(scope.ctx, { requestId: ASK, toolName: 'bash' }, next)

    expect(b.cards.getSnapshot()).toEqual([restored])
    await restored.answer('allowed-once')
    await expect(result).resolves.toBe('allowed-once')
    expect(next).not.toHaveBeenCalled()
    // The live answer travelled over the waterfall, not the late-answer entry.
    expect(b.answerLate).not.toHaveBeenCalled()
    await scope.fiber.dispose()
    await b.ctx.fiber.dispose()
  })

  it('keeps one card when the projection lists an ask a live request already presents', async () => {
    const b = await bench()
    const scope = createScope(b.ctx, SESSION_ID)
    await scope.fiber.await()
    const next = vi.fn(() => Promise.resolve<'unavailable'>('unavailable'))
    const result = b.listener().call(scope.ctx, { requestId: ASK, toolName: 'bash' }, next)

    b.approvals.set([ask()])

    const cards = b.cards.getSnapshot()
    expect(cards).toHaveLength(1)
    await cards[0]!.answer('rejected')
    await expect(result).resolves.toBe('rejected')
    expect(b.answerLate).not.toHaveBeenCalled()
    await scope.fiber.dispose()
    await b.ctx.fiber.dispose()
  })

  it('removes an adopted card when the request is settled elsewhere', async () => {
    const b = await bench([ask()])
    const restored = b.cards.getSnapshot()[0]!
    const scope = createScope(b.ctx, SESSION_ID)
    await scope.fiber.await()
    const result = b.listener().call(scope.ctx, { requestId: ASK, toolName: 'bash' }, () => Promise.resolve('unavailable'))

    // Another browser answered: the projection stops listing the ask.
    b.approvals.set([])

    expect(b.cards.getSnapshot()).toEqual([])
    await restored.result.catch(() => {})
    await result.catch(() => {})
    await scope.fiber.dispose()
    await b.ctx.fiber.dispose()
  })

  it('removes an adopted card when the live request is cancelled', async () => {
    const b = await bench([ask()])
    const scope = createScope(b.ctx, SESSION_ID)
    await scope.fiber.await()
    const controller = new AbortController()
    const reason = new Error('cancelled by host')
    const result = b.listener().call(
      scope.ctx,
      { requestId: ASK, toolName: 'bash', signal: controller.signal },
      () => Promise.resolve('unavailable'),
    )
    // Observe the rejection before it fires: the waterfall ends with the abort.
    const outcome = result.then(() => undefined, (error: unknown) => error)
    expect(b.cards.getSnapshot()).toHaveLength(1)

    controller.abort(reason)

    await vi.waitFor(() => { expect(b.cards.getSnapshot()).toEqual([]) })
    expect(await outcome).toBe(reason)
    await scope.fiber.dispose()
    await b.ctx.fiber.dispose()
  })

  it('retires a card the Host can no longer settle instead of rebuilding it', async () => {
    const b = await bench([ask()])
    const warn = vi.spyOn(b.ctx.logger, 'warn').mockImplementation(() => {})
    b.answerLate.mockResolvedValueOnce({
      ok: false,
      error: { code: 'approval/not-pending', message: 'approval request ask-1 is not awaiting a decision' },
    })
    const pending = b.cards.getSnapshot()[0]!

    await expect(pending.answer('allowed-once')).rejects.toThrow(/approval\/not-pending/)

    expect(b.cards.getSnapshot()).toEqual([])
    // The retirement is reported with locale-owned copy, not hardcoded text.
    expect(warn).toHaveBeenCalledExactlyOnceWith('approval/not-pending: copy:unavailable')
    // The projection still lists the ask after a Host restart; reconcile must not rebuild it.
    b.approvals.set([ask()])
    expect(b.cards.getSnapshot()).toEqual([])
    await b.ctx.fiber.dispose()
  })

  it('does not rebuild a card between its answer and the projection clearing', async () => {
    const b = await bench([ask()])
    const pending = b.cards.getSnapshot()[0]!

    await pending.answer('allowed-once')
    // The decision is not committed yet: the projection still lists the ask.
    b.approvals.set([ask()])

    expect(b.cards.getSnapshot()).toEqual([])
    await b.ctx.fiber.dispose()
  })

  it('keeps a live card when a reconcile sees no projection value', async () => {
    const b = await bench()
    const scope = createScope(b.ctx, SESSION_ID)
    await scope.fiber.await()
    const controller = new AbortController()
    const next = vi.fn(() => Promise.resolve<'unavailable'>('unavailable'))
    const result = b.listener().call(
      scope.ctx,
      { requestId: ASK, toolName: 'bash', signal: controller.signal },
      next,
    )
    const outcome = result.then(() => undefined, (error: unknown) => error)
    expect(b.cards.getSnapshot()).toHaveLength(1)

    // A live dispatch may arrive before the projection frame, and any list
    // change reconciles meanwhile; the live card must survive that window.
    b.approvals.set([])
    b.approvals.set(undefined)

    expect(b.cards.getSnapshot()).toHaveLength(1)
    expect(next).not.toHaveBeenCalled()

    controller.abort(new Error('cleanup'))
    await vi.waitFor(() => { expect(b.cards.getSnapshot()).toEqual([]) })
    await outcome
    await scope.fiber.dispose()
    await b.ctx.fiber.dispose()
  })

  it('restores a card after a transport abort withdrew the live one', async () => {
    const b = await bench()
    const scope = createScope(b.ctx, SESSION_ID)
    await scope.fiber.await()
    const controller = new AbortController()
    const result = b.listener().call(
      scope.ctx,
      { requestId: ASK, toolName: 'bash', signal: controller.signal },
      () => Promise.resolve<'unavailable'>('unavailable'),
    )
    const outcome = result.then(() => undefined, (error: unknown) => error)
    expect(b.cards.getSnapshot()).toHaveLength(1)

    // A dropped connection is not an answer.
    controller.abort(new Error('transport closed'))
    await vi.waitFor(() => { expect(b.cards.getSnapshot()).toEqual([]) })
    b.approvals.set([ask()])

    const restored = b.cards.getSnapshot()[0]
    expect(restored).toBeDefined()
    await restored!.answer('allowed-once')
    expect(b.answerLate).toHaveBeenCalledExactlyOnceWith(SESSION_ID, ASK, 'allowed-once')
    await outcome
    await scope.fiber.dispose()
    await b.ctx.fiber.dispose()
  })

  it('skips a listed Session that has no binding', async () => {
    const b = await bench([ask()])
    expect(b.cards.getSnapshot()).toHaveLength(1)

    b.list.set({
      ids: [SESSION_ID, 'ghost' as SessionId],
      byId: { [SESSION_ID]: { id: SESSION_ID }, ['ghost' as SessionId]: { id: 'ghost' as SessionId } },
      phase: 'ready' as const,
      subagentsByParent: {},
      jobsBySession: {},
      currentAddress: undefined,
    })

    expect(b.cards.getSnapshot()).toHaveLength(1)
    await b.ctx.fiber.dispose()
  })

  it('unsubscribes the projection of a Session that stops binding', async () => {
    const b = await bench()
    expect(b.approvals.subscribers()).toBe(1)

    b.list.set({ ids: [], byId: {}, phase: 'ready' as const, subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined })

    expect(b.approvals.subscribers()).toBe(0)
    await b.ctx.fiber.dispose()
  })
})

describe('ApprovalCards', () => {
  function recorder() {
    const published = new Map<PendingApproval, () => Promise<void>>()
    const publish = (pending: PendingApproval, delegate: () => Promise<void>): (() => void) => {
      published.set(pending, delegate)
      return () => { published.delete(pending) }
    }
    return { publish, published }
  }

  const card = (): PendingApproval => new PendingApproval(SESSION_ID, { requestId: ASK, toolName: 'bash' })

  it('keeps the card it already presents', async () => {
    const { publish, published } = recorder()
    const cards = new ApprovalCards(publish)
    const pending = card()

    expect(cards.present(SESSION_ID, ASK, pending)).toBe(pending)
    expect(cards.present(SESSION_ID, ASK, card())).toBe(pending)
    expect(published.size).toBe(1)

    pending.abort(new Error('cleanup'))
    await pending.result.catch(() => {})
  })

  it('presents a card that names no ask by its own key', async () => {
    const { publish, published } = recorder()
    const cards = new ApprovalCards(publish)
    const pending = new PendingApproval(SESSION_ID, { toolName: 'bash' })

    expect(cards.present(SESSION_ID, undefined, pending)).toBe(pending)
    expect(published.size).toBe(1)

    await pending.answer('rejected')
    expect(cards.get(SESSION_ID, ASK)).toBeUndefined()
    expect(published.size).toBe(0)
  })

  it('ignores an adoption for an ask it does not present', async () => {
    const cards = new ApprovalCards(recorder().publish)

    expect(() => { cards.adopt(SESSION_ID, ASK, () => Promise.resolve()) }).not.toThrow()
    expect(cards.get(SESSION_ID, ASK)).toBeUndefined()
  })

  it('releases the live waterfall when the pending set drops the card', async () => {
    const { publish, published } = recorder()
    const cards = new ApprovalCards(publish)
    const release = vi.fn(() => Promise.resolve())
    const pending = cards.present(SESSION_ID, ASK, card(), release)

    await published.get(pending)!()

    expect(cards.get(SESSION_ID, ASK)).toBeUndefined()
    expect(published.size).toBe(0)
    expect(release).toHaveBeenCalledOnce()
    pending.abort(new Error('cleanup'))
    await pending.result.catch(() => {})
  })

  it('does not retire an ask whose card was withdrawn instead of answered', async () => {
    const cards = new ApprovalCards(recorder().publish)
    const pending = cards.present(SESSION_ID, ASK, card())

    pending.abort(new Error('client went away'))
    await pending.result.catch(() => {})

    expect(cards.get(SESSION_ID, ASK)).toBeUndefined()
    expect(cards.retired(SESSION_ID, ASK)).toBe(false)
  })

  it('replaces the live cancellation lifetime when a card is adopted twice', async () => {
    const stale = new AbortController()
    const live = new AbortController()
    const pending = new PendingApproval(SESSION_ID, { requestId: ASK, toolName: 'bash' })

    pending.attachLive(stale.signal)
    pending.attachLive(live.signal)
    stale.abort(new Error('stale lifetime'))
    expect(pending.answerable).toBe(true)

    live.abort(new Error('live lifetime'))
    await expect(pending.result).rejects.toThrow('live lifetime')
  })

  it('ends a card whose live lifetime is already aborted', async () => {
    const controller = new AbortController()
    controller.abort(new Error('already gone'))
    const pending = new PendingApproval(SESSION_ID, { requestId: ASK, toolName: 'bash' })

    pending.attachLive(controller.signal)

    await expect(pending.result).rejects.toThrow('already gone')
  })

  it('forgets a retired ask once the projection stops listing it', async () => {
    const cards = new ApprovalCards(recorder().publish)
    const pending = cards.present(SESSION_ID, ASK, card())

    await pending.answer('rejected')
    expect(cards.retired(SESSION_ID, ASK)).toBe(true)

    cards.prune(new Set())
    expect(cards.retired(SESSION_ID, ASK)).toBe(false)
  })
})
