/**
 * Session-list subagent activity: a row reports its live direct-child counts
 * from the Host, so a Client learns that a delegating Session still has work
 * open without a loaded catalog, without a local Session for an external run,
 * and even while the parent Session itself is cold.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  createInboxStub, provideWorkingDirectoryFixture, unsupportedModel,
} from '@deepseek-ai/dsh-agent-loop-testkit'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { SessionSummary } from '@deepseek-ai/dsh-api-session-controller/types'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { SubagentResult, SubagentRun } from '@deepseek-ai/dsh-subagent'
import {
  createSessionTestRemote, installSessionReadTestServices, testSessionPersistence,
} from './test-remote.ts'

const defaults = {
  defaultModelSelection: () => ({ provider: 'fixture', model: 'fixture-model' }),
  cwd: '/tmp',
}

const PARENT = SessionId('activity-parent')
const CHILD = SessionId('activity-child')
const SIBLING = SessionId('activity-sibling')

const contexts: Context[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

/** A persisted parent header, listed without a live Session when it has no Agent. */
const persistedParent: SessionHeader = {
  version: SESSION_FORMAT_VERSION,
  id: PARENT,
  createdAt: 1,
  isSeeded: false,
  cwd: '/workspace',
}

async function harness(persisted: readonly SessionHeader[] = []) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionProjectionRegistry)
  ctx.provide('sessionPersistence', testSessionPersistence(ctx, {
    list: () => Promise.resolve([...persisted]),
    inspect: () => Promise.resolve(undefined),
  }) as never)
  installSessionReadTestServices(ctx)
  provideWorkingDirectoryFixture(ctx)
  const remote = await createSessionTestRemote(ctx, defaults)
  return { ctx, remote }
}

/**
 * Create one direct child Session and register a non-driving Agent for it.
 * @param ctx - harness Context holding the Session store and Agent registry.
 * @param childId - child Session identity.
 * @param status - lifecycle state the Agent registry reports.
 * @returns the child Agent registered under `childId`.
 */
function registerChild(ctx: Context, childId: SessionId, status: 'running' | 'idle'): Agent {
  ctx.sessions.create(childId, {
    meta: { cwd: '/workspace', parentSession: PARENT, origin: 'subagent' },
  })
  return registerAgent(ctx, childId, status)
}

/**
 * Register a non-driving Agent for an existing Session.
 * @param ctx - harness Context holding the Agent registry.
 * @param id - Session the Agent owns.
 * @param status - lifecycle state the registry reports.
 * @returns the registered Agent.
 */
function registerAgent(ctx: Context, id: SessionId, status: 'running' | 'idle'): Agent {
  const session = ctx.sessions.get(id)
  if (session === undefined) throw new Error(`missing Session ${id}`)
  const inbox = createInboxStub()
  const agent: Agent = {
    id,
    session,
    ctx,
    options: {},
    status,
    model: unsupportedModel(),
    inbox,
    send: (message, target) => { inbox.append(target, message) },
    followup: message => { inbox.append('next-turn', message) },
    steer: message => { inbox.append('next-step', message) },
    inject: message => { inbox.append('next-step', message) },
    cancel: () => {},
    whenIdle: () => Promise.resolve(),
    runMaintenance: task => task(new AbortController().signal),
  }
  // `enter` inserts synchronously; `register` would await its own effect and a
  // caller that checks the exact live agent immediately would miss it.
  ctx.agents.enter(agent)
  return agent
}

/**
 * Read the list rows the remote serves.
 * @param remote - harness Session Remote.
 * @returns every served row.
 */
async function rows(remote: Awaited<ReturnType<typeof harness>>['remote']): Promise<readonly SessionSummary[]> {
  const response = await remote.list({})
  if (!response.ok) throw new Error(`list failed: ${JSON.stringify(response.error)}`)
  return response.value.items
}

/**
 * Find one served row.
 * @param remote - harness Session Remote.
 * @param id - Session whose row is read.
 * @returns the row.
 */
async function rowOf(
  remote: Awaited<ReturnType<typeof harness>>['remote'],
  id: SessionId,
): Promise<SessionSummary> {
  const row = (await rows(remote)).find(item => item.sessionId === id)
  if (row === undefined) throw new Error(`no row for ${id}`)
  return row
}

describe('session.list subagent activity', () => {
  it('republishes the parent summary when an external execution starts and ends', async () => {
    const { ctx, remote } = await harness()
    await ctx.plugin(SubagentRuntime)
    const parent = ctx.sessions.create(PARENT, { meta: { cwd: '/workspace' } })
    const parentAgent = registerAgent(ctx, parent.id, 'idle')
    const result = Promise.withResolvers<SubagentResult>()
    const run: SubagentRun = {
      id: SessionId('external-run'),
      result: result.promise,
      dispose: () => {
        result.resolve({ output: [], stopReason: 'aborted' })
        return Promise.resolve()
      },
    }
    ctx.subagents.registerProvider({
      name: 'external',
      capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false },
      inheritsParentContext: false,
      start: () => Promise.resolve(run),
    })
    const added: SessionId[] = []
    ctx.on('api-session/added', summary => { added.push(summary.sessionId) })
    const signal = new AbortController()
    const activation = await ctx.subagents.startActivation({
      provider: 'external', label: 'External work', parent: parentAgent, signal: signal.signal, delivery: 'caller',
      prompt: [{ type: 'text', text: 'Work independently' }],
    })

    expect(added).toContain(parent.id)
    expect(await rowOf(remote, PARENT)).toMatchObject({
      subagentActivity: { running: 0, external: 1 },
    })

    await activation.dispose()
    expect(added.filter(id => id === parent.id).length).toBeGreaterThan(1)
    expect(await rowOf(remote, PARENT)).not.toHaveProperty('subagentActivity')
  })

  it('counts running direct children on an attached parent', async () => {
    const { ctx, remote } = await harness()
    ctx.sessions.create(PARENT, { meta: { cwd: '/workspace' } })
    registerChild(ctx, CHILD, 'running')
    registerChild(ctx, SIBLING, 'idle')

    expect(await rowOf(remote, PARENT)).toMatchObject({
      subagentActivity: { running: 1, external: 0 },
    })
  })

  it('omits the field when no direct child is active', async () => {
    const { ctx, remote } = await harness()
    ctx.sessions.create(PARENT, { meta: { cwd: '/workspace' } })
    registerChild(ctx, CHILD, 'idle')

    expect(await rowOf(remote, PARENT)).not.toHaveProperty('subagentActivity')
  })

  it('reports a running child of a cold parent from the persisted parent row', async () => {
    const { ctx, remote } = await harness([persistedParent])
    registerChild(ctx, CHILD, 'running')

    expect(await rowOf(remote, PARENT)).toMatchObject({
      running: false,
      subagentActivity: { running: 1, external: 0 },
    })
  })

  it('counts active external runs that own no local Session', async () => {
    const { ctx, remote } = await harness()
    ctx.provide('subagents', {
      externalChildCounts: () => new Map([[PARENT, 2]]),
    } as never)
    ctx.sessions.create(PARENT, { meta: { cwd: '/workspace' } })

    expect(await rowOf(remote, PARENT)).toMatchObject({
      subagentActivity: { running: 0, external: 2 },
    })
  })

  it('ignores a grandchild when counting a parent row', async () => {
    const { ctx, remote } = await harness()
    ctx.sessions.create(PARENT, { meta: { cwd: '/workspace' } })
    registerChild(ctx, CHILD, 'running')
    const grandchild = ctx.sessions.create(SIBLING, {
      meta: { cwd: '/workspace', parentSession: CHILD, origin: 'subagent' },
    })
    const inbox = createInboxStub()
    ctx.agents.register({
      id: grandchild.id,
      session: grandchild,
      ctx,
      options: {},
      status: 'running',
      model: unsupportedModel(),
      inbox,
      send: () => {},
      followup: () => {},
      steer: () => {},
      inject: () => {},
      cancel: () => {},
      whenIdle: () => Promise.resolve(),
      runMaintenance: task => task(new AbortController().signal),
    })

    expect(await rowOf(remote, PARENT)).toMatchObject({
      subagentActivity: { running: 1, external: 0 },
    })
    expect(await rowOf(remote, CHILD)).toMatchObject({
      subagentActivity: { running: 1, external: 0 },
    })
  })
})
