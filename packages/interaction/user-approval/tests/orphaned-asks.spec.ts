import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import ApprovalService, { ApprovalRequestId, type ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import { describe, expect, it, onTestFinished, vi } from 'vitest'

async function store(): Promise<Context> {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  return ctx
}

/** The log a crashed process leaves behind: one ask, no decision. */
function crashedLog(ctx: Context, id: string): readonly SessionEvent[] {
  const session = ctx.sessions.create(SessionId(`crashed-${id}`))
  session.append('turn/start', { turn: 1 })
  session.append('approval/asked', { id: ApprovalRequestId(id), toolName: 'bash' })
  return session.snapshotEvents()
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

describe('orphaned approval asks', () => {
  it('settles a dangling ask as cancelled when a service starts over a restored log', async () => {
    const previous = await store()
    const seed = crashedLog(previous, 'ask-1')

    const ctx = await store()
    const session = ctx.sessions.create(SessionId('restored'), { seed })
    await ctx.plugin(ApprovalService)

    expect(decided(session)).toEqual([{ id: ApprovalRequestId('ask-1'), outcome: 'cancelled' }])
    expect(ctx.sessionProjections.snapshot(session).values.approvalState).toEqual([])
  })

  it('appends no second decision when another service instance starts over the same session', async () => {
    const previous = await store()
    const seed = crashedLog(previous, 'ask-1')

    const ctx = await store()
    const session = ctx.sessions.create(SessionId('restored'), { seed })
    const owner = await ctx.plugin(ApprovalService)
    expect(decided(session)).toHaveLength(1)

    await owner.dispose()
    await ctx.plugin(ApprovalService)

    expect(decided(session)).toEqual([{ id: ApprovalRequestId('ask-1'), outcome: 'cancelled' }])
  })

  it('settles a dangling ask whose session is restored after the service is already mounted', async () => {
    const previous = await store()
    const seed = crashedLog(previous, 'ask-2')

    const ctx = await store()
    await ctx.plugin(ApprovalService)
    const session = ctx.sessions.create(SessionId('restored-late'), { seed })

    await vi.waitFor(() => { expect(decided(session)).toHaveLength(1) })
    expect(decided(session)).toEqual([{ id: ApprovalRequestId('ask-2'), outcome: 'cancelled' }])
    expect(ctx.sessionProjections.snapshot(session).values.approvalState).toEqual([])
  })

  it('keeps a live ask on the live path and never reports it cancelled', async () => {
    const ctx = await store()
    await ctx.plugin(ApprovalService)
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1 })
    const agent = { session } as Agent
    ctx.on('approval/request', () => new Promise<ApprovalOutcome>(() => {}))
    const ids: ApprovalRequestId[] = []
    ctx.on('session/event', (subject, event) => {
      if (subject === session && event.type === 'approval/asked') ids.push(event.data.id)
    })

    const granted = ctx.approval.request({ agent, toolName: 'bash' })
    await vi.waitFor(() => { expect(ids).toHaveLength(1) })
    const grantedId = ids[0]
    if (grantedId === undefined) throw new Error('the request recorded no ask')
    // Creating a sibling Session must not settle this Session's live ask.
    ctx.sessions.create()
    await Promise.resolve()
    expect(decided(session)).toEqual([])

    ctx.approval.answerLate(agent, grantedId, 'allowed-once')
    await expect(granted).resolves.toBe('allowed-once')
    expect(decided(session)).toEqual([{ id: grantedId, outcome: 'allowed-once' }])

    const refused = ctx.approval.request({ agent, toolName: 'bash' })
    await vi.waitFor(() => { expect(ids).toHaveLength(2) })
    const refusedId = ids[1]
    if (refusedId === undefined) throw new Error('the request recorded no ask')
    ctx.approval.answerLate(agent, refusedId, 'rejected')
    await expect(refused).resolves.toBe('rejected')
    expect(decided(session)).toEqual([
      { id: grantedId, outcome: 'allowed-once' },
      { id: refusedId, outcome: 'rejected' },
    ])
  })

  it('cancels an ask only the projection knows before refusing the late answer', async () => {
    const ctx = await store()
    await ctx.plugin(ApprovalService)
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1 })
    const id = ApprovalRequestId('unannounced-ask')
    session.append('approval/asked', { id, toolName: 'bash' })
    const agent = { session } as Agent

    expect(failureOf(() => { ctx.approval.answerLate(agent, id, 'allowed-once') }))
      .toMatchObject({ code: 'approval/not-pending', details: { id } })
    expect(failureOf(() => { ctx.approval.answerLate(agent, ApprovalRequestId('never-asked'), 'rejected') }))
      .toMatchObject({ code: 'approval/not-pending', details: { id: 'never-asked' } })

    expect(decided(session)).toEqual([{ id, outcome: 'cancelled' }])
    expect(ctx.sessionProjections.snapshot(session).values.approvalState).toEqual([])
    expect(failureOf(() => { ctx.approval.answerLate(agent, id, 'rejected') }))
      .toMatchObject({ code: 'approval/not-pending', details: { id } })
    expect(decided(session)).toEqual([{ id, outcome: 'cancelled' }])
  })

  it('logs a deferred sweep whose append fails instead of failing the creation', async () => {
    const previous = await store()
    const seed = crashedLog(previous, 'ask-3')

    const ctx = await store()
    await ctx.plugin(ApprovalService)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const session = ctx.sessions.create(SessionId('restored-unwritable'), { seed })
    const failure = new Error('append refused')
    vi.spyOn(session, 'append').mockImplementation(() => { throw failure })

    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('orphaned-ask sweep failed: Error: append refused'))
    })
  })
})
