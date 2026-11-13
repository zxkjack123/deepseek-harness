import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import ApprovalService, { ApprovalRequestId, type ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import { describe, expect, it, onTestFinished } from 'vitest'

async function mounted(): Promise<Context> {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(ApprovalService)
  return ctx
}

function openSession(ctx: Context): Session {
  const session = ctx.sessions.create()
  session.append('turn/start', { turn: 1 })
  return session
}

/** Resolve with the identity of the next ask this Session records. */
function nextAsk(ctx: Context, session: Session): Promise<ApprovalRequestId> {
  const found = Promise.withResolvers<ApprovalRequestId>()
  ctx.on('session/event', (subject, event) => {
    if (subject === session && event.type === 'approval/asked') found.resolve(event.data.id)
  })
  return found.promise
}

/** Every recorded decision of one Session. */
function decided(session: Session): Array<{ id: ApprovalRequestId; outcome: ApprovalOutcome }> {
  return session.snapshotEvents().flatMap(event => (
    event.type === 'approval/decided' ? [{ id: event.data.id, outcome: event.data.outcome }] : []
  ))
}

/** The structured failure one call produced. */
function failureOf(call: () => void): unknown {
  try {
    call()
  } catch (error: unknown) {
    return error
  }
  return undefined
}

describe('ApprovalService.answerLate', () => {
  it('settles a request whose live answerer is still waiting, and releases that answerer', async () => {
    const ctx = await mounted()
    const session = openSession(ctx)
    const agent = { session } as Agent
    const dispatched = Promise.withResolvers<AbortSignal>()
    ctx.on('approval/request', (request) => {
      if (request.signal !== undefined) dispatched.resolve(request.signal)
      return new Promise<ApprovalOutcome>(() => {})
    })
    const ask = nextAsk(ctx, session)
    const request = ctx.approval.request({ agent, toolName: 'bash', reason: 'needs write access' })
    const id = await ask
    const signal = await dispatched.promise
    expect(ctx.sessionProjections.snapshot(session).values.approvalState).toEqual([
      { id, toolName: 'bash', reason: 'needs write access' },
    ])

    ctx.approval.answerLate(agent, id, 'allowed-once')

    await expect(request).resolves.toBe('allowed-once')
    expect(decided(session)).toEqual([{ id, outcome: 'allowed-once' }])
    expect(signal.aborted).toBe(true)
    expect(ctx.sessionProjections.snapshot(session).values.approvalState).toEqual([])
  })

  it('refuses the second answer and records one decision', async () => {
    const ctx = await mounted()
    const session = openSession(ctx)
    const agent = { session } as Agent
    ctx.on('approval/request', () => new Promise<ApprovalOutcome>(() => {}))
    const ask = nextAsk(ctx, session)
    const request = ctx.approval.request({ agent, toolName: 'bash' })
    const id = await ask

    ctx.approval.answerLate(agent, id, 'rejected')
    const conflict = failureOf(() => { ctx.approval.answerLate(agent, id, 'allowed-once') })

    expect(conflict).toBeInstanceOf(RemoteError)
    expect(conflict).toMatchObject({ code: 'approval/already-answered', details: { id } })
    await expect(request).resolves.toBe('rejected')
    expect(decided(session)).toEqual([{ id, outcome: 'rejected' }])
  })

  it('refuses an unknown id and a settled id with distinct structured failures', async () => {
    const ctx = await mounted()
    const session = openSession(ctx)
    const agent = { session } as Agent
    ctx.on('approval/request', () => Promise.resolve<ApprovalOutcome>('allowed-once'))

    expect(failureOf(() => { ctx.approval.answerLate(agent, ApprovalRequestId('never-asked'), 'rejected') }))
      .toMatchObject({ code: 'approval/not-pending', details: { id: 'never-asked' } })

    await ctx.approval.request({ agent, toolName: 'bash' })
    const settled = decided(session)[0]
    if (settled === undefined) throw new Error('the request recorded no decision')
    expect(failureOf(() => { ctx.approval.answerLate(agent, settled.id, 'rejected') }))
      .toMatchObject({ code: 'approval/not-pending' })
  })

  it('refuses an id that belongs to another Session without settling it', async () => {
    const ctx = await mounted()
    const session = openSession(ctx)
    const agent = { session } as Agent
    const other = ctx.sessions.create()
    ctx.on('approval/request', () => new Promise<ApprovalOutcome>(() => {}))
    const ask = nextAsk(ctx, session)
    const request = ctx.approval.request({ agent, toolName: 'bash' })
    const id = await ask

    const failure = failureOf(() => { ctx.approval.answerLate({ session: other } as Agent, id, 'rejected') })
    expect(failure).toMatchObject({ code: 'approval/wrong-session', details: { id } })

    ctx.approval.answerLate(agent, id, 'allowed-once')
    await expect(request).resolves.toBe('allowed-once')
    expect(decided(session)).toEqual([{ id, outcome: 'allowed-once' }])
  })

  it('refuses an outcome outside the decision vocabulary', async () => {
    const ctx = await mounted()
    const session = openSession(ctx)
    const agent = { session } as Agent
    ctx.on('approval/request', () => new Promise<ApprovalOutcome>(() => {}))
    const ask = nextAsk(ctx, session)
    const request = ctx.approval.request({ agent, toolName: 'bash' })
    const id = await ask

    // The declaration admits two outcomes; a Client built against another
    // vocabulary can still put a third on the wire.
    const failure = failureOf(() => {
      Reflect.apply(Reflect.get(ctx.approval, 'answerLate'), ctx.approval, [agent, id, 'cancelled'])
    })
    expect(failure).toMatchObject({ code: 'approval/bad-outcome', details: { outcome: 'cancelled' } })

    ctx.approval.answerLate(agent, id, 'rejected')
    await expect(request).resolves.toBe('rejected')
  })
})
