import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import TypertGatewayService from '@deepseek-ai/dsh-api-gateway'
import type {
  RemoteEventHostInfo,
  TypertRemoteEventInvocation,
  TypertRemoteEventSource,
} from '@deepseek-ai/dsh-api-gateway'
import RemoteAccessService from '@deepseek-ai/dsh-api-remote-access'
import { apply as applyConnection, inject as connectionInject } from '@deepseek-ai/dsh-client-connection'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, inject } from '../src/index.ts'

interface GatewayProbe {
  source: TypertRemoteEventSource | undefined
  host: RemoteEventHostInfo | undefined
  removals: number
  registerRemoteEvents(
    source: TypertRemoteEventSource,
    host: RemoteEventHostInfo,
  ): () => Promise<void>
}

async function setup(): Promise<{
  readonly ctx: Context
  readonly gateway: GatewayProbe
  readonly fiber: Fiber
}> {
  const ctx = new Context()
  const gateway: GatewayProbe = {
    source: undefined,
    host: undefined,
    removals: 0,
    registerRemoteEvents(source, host) {
      gateway.source = source
      gateway.host = host
      return async () => {
        if (gateway.source !== source) return
        gateway.source = undefined
        gateway.host = undefined
        gateway.removals += 1
      }
    },
  }
  ctx.reflect.provide('typertGateway', gateway)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber
  return { ctx, gateway, fiber }
}

function sourceOf(gateway: GatewayProbe): TypertRemoteEventSource {
  if (gateway.source === undefined) throw new Error('fixture Gateway has no Remote event source')
  return gateway.source
}

function emitRaw(ctx: Context, event: string, args: readonly unknown[]): void {
  const emit = ctx.emit.bind(ctx) as (name: string, ...values: readonly unknown[]) => void
  emit(event, ...args)
}

function waterfallRaw(
  ctx: Context,
  target: object,
  event: string,
  args: readonly unknown[],
  next: () => Promise<unknown>,
): Promise<unknown> {
  const waterfall = ctx.waterfall.bind(ctx) as (
    receiver: object,
    name: string,
    ...values: readonly unknown[]
  ) => Promise<unknown>
  return waterfall(target, event, ...args, next)
}

function invocationOf(value: unknown): TypertRemoteEventInvocation {
  if (typeof value !== 'object' || value === null || !Object.hasOwn(value, 'context')) {
    throw new Error('fixture did not receive a scoped Remote Event invocation')
  }
  return value as TypertRemoteEventInvocation
}

describe('Remote event Host source', () => {
  it('registers the Host home used by Client connection generations', async () => {
    const { gateway, fiber } = await setup()
    expect(gateway.host?.home).toBeTypeOf('string')
    expect(gateway.host?.home.length).toBeGreaterThan(0)
    await fiber.dispose()
    expect(gateway.host).toBeUndefined()
  })

  it('gives each Client stream an independent allowlisted event queue', async () => {
    const { ctx, gateway, fiber } = await setup()
    const firstAbort = new AbortController()
    const secondAbort = new AbortController()
    const first = sourceOf(gateway)(firstAbort.signal)[Symbol.asyncIterator]()
    const second = sourceOf(gateway)(secondAbort.signal)[Symbol.asyncIterator]()

    emitRaw(ctx, 'settings/document-updated', ['ui-theme', 1])
    await expect(first.next()).resolves.toEqual({
      done: false,
      value: { event: 'settings/document-updated', args: ['ui-theme', 1] },
    })
    await expect(second.next()).resolves.toEqual({
      done: false,
      value: { event: 'settings/document-updated', args: ['ui-theme', 1] },
    })

    emitRaw(ctx, 'goal/activation-changed', [{
      sessionId: 'session-1',
      goal: { id: 'goal-1', revision: 1, activation: 'disarmed' },
    }])
    await expect(first.next()).resolves.toEqual({
      done: false,
      value: {
        event: 'goal/activation-changed',
        args: [{ sessionId: 'session-1', goal: { id: 'goal-1', revision: 1, activation: 'disarmed' } }],
      },
    })
    await expect(second.next()).resolves.toEqual({
      done: false,
      value: {
        event: 'goal/activation-changed',
        args: [{ sessionId: 'session-1', goal: { id: 'goal-1', revision: 1, activation: 'disarmed' } }],
      },
    })

    emitRaw(ctx, 'schedule/changed', [])
    await expect(first.next()).resolves.toEqual({
      done: false,
      value: { event: 'schedule/changed', args: [] },
    })
    await expect(second.next()).resolves.toEqual({
      done: false,
      value: { event: 'schedule/changed', args: [] },
    })

    emitRaw(ctx, 'web/providers-changed', [])
    await expect(first.next()).resolves.toEqual({
      done: false,
      value: { event: 'web/providers-changed', args: [] },
    })
    await expect(second.next()).resolves.toEqual({
      done: false,
      value: { event: 'web/providers-changed', args: [] },
    })

    const firstDone = first.next()
    firstAbort.abort(new Error('first Client disconnected'))
    emitRaw(ctx, 'commands/change', [])
    await expect(firstDone).resolves.toEqual({ done: true, value: undefined })
    await expect(second.next()).resolves.toEqual({
      done: false,
      value: { event: 'commands/change', args: [] },
    })

    const secondDone = second.next()
    secondAbort.abort(new Error('second Client disconnected'))
    await expect(secondDone).resolves.toEqual({ done: true, value: undefined })

    await fiber.dispose()
    expect(gateway.source).toBeUndefined()
    expect(gateway.removals).toBe(1)
    await ctx.fiber.dispose()
  })

  it('attaches each declared resource reader to its forwarded notification', async () => {
    const { ctx, gateway, fiber } = await setup()
    const abort = new AbortController()
    const stream = sourceOf(gateway)(abort.signal)[Symbol.asyncIterator]()
    const cases: readonly (readonly [string, readonly unknown[], string])[] = [
      ['api-session/activity', ['s-activity', 1], 's-activity'],
      ['api-session/added', [{ sessionId: 's-added' }], 's-added'],
      ['api-session/error', ['s-error', 'boom'], 's-error'],
      ['api-session/removed', ['s-removed'], 's-removed'],
      ['api-session/status', ['s-status', true], 's-status'],
    ]
    for (const [event, args, sessionId] of cases) {
      emitRaw(ctx, event, args)
      const next = await stream.next()
      if (next.done === true || 'context' in next.value) throw new Error(`${event} was not forwarded as a notification`)
      const frame = next.value
      expect(frame).toMatchObject({ event, args })
      expect(frame.resources?.['session']?.(...frame.args)).toBe(sessionId)
    }
    // An event that declares no resources carries no readers, so access control sees the global resource.
    emitRaw(ctx, 'commands/change', [])
    await expect(stream.next()).resolves.toEqual({ done: false, value: { event: 'commands/change', args: [] } })
    abort.abort(new Error('Client disconnected'))
    await fiber.dispose()
    await ctx.fiber.dispose()
  })

  it('rejects a non-JSON argument without poisoning the stream', async () => {
    const { ctx, gateway } = await setup()
    const abort = new AbortController()
    const iterator = sourceOf(gateway)(abort.signal)[Symbol.asyncIterator]()
    const pending = iterator.next()

    expect(() => {
      emitRaw(ctx, 'settings/document-updated', ['ui-theme', 1n])
    }).toThrow('argument 1 is not lossless JSON data')
    emitRaw(ctx, 'settings/document-updated', ['ui-theme', 2])
    await expect(pending).resolves.toEqual({
      done: false,
      value: { event: 'settings/document-updated', args: ['ui-theme', 2] },
    })

    const done = iterator.next()
    abort.abort()
    await expect(done).resolves.toEqual({ done: true, value: undefined })

    const alreadyAborted = new AbortController()
    alreadyAborted.abort()
    await expect(sourceOf(gateway)(alreadyAborted.signal)[Symbol.asyncIterator]().next())
      .resolves.toEqual({ done: true, value: undefined })
    await ctx.fiber.dispose()
  })

  it('bridges scoped waterfall result, next delegation, and rejection', async () => {
    const { ctx, gateway } = await setup()
    const abort = new AbortController()
    const iterator = sourceOf(gateway)(abort.signal)[Symbol.asyncIterator]()
    const agentCtx = ctx.extend()
    const agent = { id: 'agent-1', ctx: agentCtx }
    const target = scopeTarget(ctx, agent)
    const request = { questions: [], agent }

    await expect(async () => waterfallRaw(
      ctx,
      target,
      'user-questions/request',
      [{ questions: [], agent: { id: 'agent-2', ctx: ctx.extend() } }],
      () => Promise.resolve('host fallback'),
    )).rejects.toThrow('must carry its Agent directly')

    const claimed = waterfallRaw(
      ctx,
      target,
      'user-questions/request',
      [request],
      () => Promise.resolve('host fallback'),
    )
    const claimedDispatch = invocationOf((await iterator.next()).value)
    expect(claimedDispatch).toMatchObject({
      event: 'user-questions/request',
      request,
      context: { value: agentCtx, subject: agent, agentId: 'agent-1' },
    })
    claimedDispatch.resolve({ kind: 'result', value: 'client answer' })
    await expect(claimed).resolves.toBe('client answer')

    const delegated = waterfallRaw(
      ctx,
      target,
      'user-questions/request',
      [request],
      () => Promise.resolve('host fallback'),
    )
    const delegatedDispatch = invocationOf((await iterator.next()).value)
    delegatedDispatch.resolve({ kind: 'next' })
    await expect(delegated).resolves.toBe('host fallback')

    const rejection = Object.assign(new Error('the user cancelled ask_user_question'), {
      code: 'ASK_CANCELLED',
    })
    const rejected = waterfallRaw(
      ctx,
      target,
      'user-questions/request',
      [request],
      () => Promise.resolve('host fallback'),
    )
    const rejectedAssertion = expect(rejected).rejects.toBe(rejection)
    const rejectedDispatch = invocationOf((await iterator.next()).value)
    rejectedDispatch.reject(rejection)
    await rejectedAssertion

    const done = iterator.next()
    abort.abort()
    await expect(done).resolves.toEqual({ done: true, value: undefined })
    await ctx.fiber.dispose()
  })

  it('rejects a queued scoped waterfall when its source is withdrawn', async () => {
    const { ctx, gateway, fiber } = await setup()
    const abort = new AbortController()
    const iterator = sourceOf(gateway)(abort.signal)[Symbol.asyncIterator]()
    const delivery = iterator.next()
    const agent = { id: 'agent-1', ctx: ctx.extend() }
    const reason = new Error('forwarded event source removed')
    const pending = waterfallRaw(
      ctx,
      scopeTarget(ctx, agent),
      'user-questions/request',
      [{ questions: [], agent }],
      () => Promise.resolve('host fallback'),
    )
    const rejected = expect(pending).rejects.toBe(reason)

    abort.abort(reason)

    await rejected
    await expect(delivery).resolves.toEqual({ done: true, value: undefined })
    await fiber.dispose()
    await ctx.fiber.dispose()
  })
})

describe('Remote event waterfall across the composed Gateway', () => {
  it('asks the Client and the Host answerer, and a Host decision dismisses the Client card', async () => {
    const host = await composed()
    const client = await openEventStream(host.ctx)
    const agent = { id: 'agent-host-wins', ctx: host.ctx.extend() }
    const asked: object[] = []
    host.ctx.on('approval/request', (request) => {
      asked.push(request)
      return Promise.resolve<ApprovalOutcome>('rejected')
    })

    const pending = waterfallRaw(
      host.ctx,
      scopeTarget(host.ctx, agent),
      'approval/request',
      [{ prompt: 'ship', agent }],
      () => Promise.resolve<ApprovalOutcome>('unavailable'),
    )

    await expect(pending).resolves.toBe('rejected')
    expect(asked).toHaveLength(1)
    await vi.waitFor(() => {
      const frames = client.frames()
      const delivered = frames.find(frame => frame.type === 'waterfall')
      expect(delivered).toBeDefined()
      expect(frames).toContainEqual({ type: 'cancel', eventId: delivered?.eventId })
    })
    await client.stop()
  })

  it('lets an early Client answer win while the Host answerer stays pending', async () => {
    const host = await composed()
    const client = await openEventStream(host.ctx)
    const agent = { id: 'agent-client-wins', ctx: host.ctx.extend() }
    const asked = vi.fn((): Promise<ApprovalOutcome> => new Promise<ApprovalOutcome>(() => {}))
    host.ctx.on('approval/request', asked)

    const pending = waterfallRaw(
      host.ctx,
      scopeTarget(host.ctx, agent),
      'approval/request',
      [{ prompt: 'ship', agent }],
      () => Promise.resolve<ApprovalOutcome>('unavailable'),
    )
    let delivered: Record<string, unknown> | undefined
    await vi.waitFor(() => {
      delivered = client.frames().find(frame => frame.type === 'waterfall')
      expect(delivered).toBeDefined()
    })
    expect(asked).toHaveBeenCalledTimes(1)

    await sendEventResult(host, client.clientId, String(delivered?.eventId), {
      kind: 'result',
      value: 'allowed-once',
    })

    await expect(pending).resolves.toBe('allowed-once')
    await client.stop()
  })

  it('keeps a late Client answer in the race after the Host chain rejects', async () => {
    const host = await composed()
    const client = await openEventStream(host.ctx)
    const agent = { id: 'agent-late-client', ctx: host.ctx.extend() }
    host.ctx.on('approval/request', () => Promise.reject(new Error('the Host answerer failed')))

    const pending = waterfallRaw(
      host.ctx,
      scopeTarget(host.ctx, agent),
      'approval/request',
      [{ prompt: 'ship', agent }],
      () => Promise.resolve<ApprovalOutcome>('unavailable'),
    )
    let delivered: Record<string, unknown> | undefined
    await vi.waitFor(() => {
      delivered = client.frames().find(frame => frame.type === 'waterfall')
      expect(delivered).toBeDefined()
    })

    await sendEventResult(host, client.clientId, String(delivered?.eventId), {
      kind: 'result',
      value: 'allowed-once',
    })
    await expect(pending).resolves.toBe('allowed-once')
    await client.stop()
  })

  it('delegates a Client next() to the still-pending Host answerer', async () => {
    const host = await composed()
    const client = await openEventStream(host.ctx)
    const agent = { id: 'agent-delegated', ctx: host.ctx.extend() }
    const answer = Promise.withResolvers<ApprovalOutcome>()
    host.ctx.on('approval/request', () => answer.promise)

    const pending = waterfallRaw(
      host.ctx,
      scopeTarget(host.ctx, agent),
      'approval/request',
      [{ prompt: 'ship', agent }],
      () => Promise.resolve<ApprovalOutcome>('unavailable'),
    )
    let delivered: Record<string, unknown> | undefined
    await vi.waitFor(() => {
      delivered = client.frames().find(frame => frame.type === 'waterfall')
      expect(delivered).toBeDefined()
    })

    await sendEventResult(host, client.clientId, String(delivered?.eventId), { kind: 'next' })
    answer.resolve('rejected')
    await expect(pending).resolves.toBe('rejected')
    await client.stop()
  })

  it('does not ask the Host chain when the Gateway rejects the invocation', async () => {
    const host = await composed()
    await openEventStream(host.ctx)
    const agent = { id: 'agent-rejected-request', ctx: host.ctx.extend() }
    const asked = vi.fn((): Promise<never> => new Promise<never>(() => {}))
    host.ctx.on('approval/request', asked)

    await expect(waterfallRaw(
      host.ctx,
      scopeTarget(host.ctx, agent),
      'approval/request',
      [{ prompt: 'ship', agent, notJson: 1n }],
      () => Promise.resolve<ApprovalOutcome>('unavailable'),
    )).rejects.toThrow('not lossless JSON data')
    expect(asked).not.toHaveBeenCalled()
  })

  it('asks the Host answerer when no Client stream is connected', async () => {
    const host = await composed()
    const agent = { id: 'agent-no-client', ctx: host.ctx.extend() }
    const asked = vi.fn((): Promise<ApprovalOutcome> => Promise.resolve('allowed-once'))
    host.ctx.on('approval/request', asked)

    await expect(waterfallRaw(
      host.ctx,
      scopeTarget(host.ctx, agent),
      'approval/request',
      [{ prompt: 'ship', agent }],
      () => Promise.resolve<ApprovalOutcome>('unavailable'),
    )).resolves.toBe('allowed-once')
    expect(asked).toHaveBeenCalledTimes(1)
  })

  it('returns the declared no-answerer value while delegating exactly once', async () => {
    const host = await composed()
    const agent = { id: 'agent-no-answerer', ctx: host.ctx.extend() }
    let delegated = 0

    await expect(waterfallRaw(
      host.ctx,
      scopeTarget(host.ctx, agent),
      'approval/request',
      [{ prompt: 'ship', agent }],
      () => {
        delegated += 1
        return Promise.resolve<ApprovalOutcome>('unavailable')
      },
    )).resolves.toBe('unavailable')
    expect(delegated).toBe(1)
  })

  it('keeps user-questions on the Client-first path without asking the Host chain', async () => {
    const host = await composed()
    const client = await openEventStream(host.ctx)
    const agent = { id: 'agent-questions', ctx: host.ctx.extend() }
    const asked = vi.fn((): Promise<never> => new Promise<never>(() => {}))
    host.ctx.on('user-questions/request', asked)

    const pending = waterfallRaw(
      host.ctx,
      scopeTarget(host.ctx, agent),
      'user-questions/request',
      [{ questions: [], agent }],
      () => Promise.resolve({ answers: [] }),
    )
    let delivered: Record<string, unknown> | undefined
    await vi.waitFor(() => {
      delivered = client.frames().find(frame => frame.type === 'waterfall')
      expect(delivered).toBeDefined()
    })
    expect(asked).not.toHaveBeenCalled()

    await sendEventResult(host, client.clientId, String(delivered?.eventId), {
      kind: 'result',
      value: { answers: [] },
    })
    await expect(pending).resolves.toEqual({ answers: [] })
    expect(asked).not.toHaveBeenCalled()
    await client.stop()
  })
})

interface ComposedHost {
  readonly ctx: Context
  readonly origin: string
  readonly cookie: string
}

const composedHosts: Context[] = []
afterEach(async () => {
  await Promise.all(composedHosts.splice(0).map(ctx => ctx.fiber.dispose()))
})

async function composed(): Promise<ComposedHost> {
  const ctx = new Context()
  composedHosts.push(ctx)
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  provideBrowserCredentials(ctx)
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(RemoteAccessService)
  await ctx.plugin(TypertGatewayService)
  await ctx.plugin({ inject: [...connectionInject], apply: applyConnection })
  await ctx.plugin({ inject: [...inject], apply })
  return { ctx, origin: `http://127.0.0.1:${String(ctx.webServer.port)}`, cookie: browserCookie(ctx) }
}

interface InProcessEventClient {
  readonly clientId: string
  readonly frames: () => readonly Record<string, unknown>[]
  readonly stop: () => Promise<void>
}

async function openEventStream(ctx: Context): Promise<InProcessEventClient> {
  const abort = new AbortController()
  const empty = (async function* () {})()
  const stream = await ctx.typertGateway.wireStream.open(
    '$events', { args: {} }, empty, ctx.connection.browserPeer, abort.signal,
  )
  const iterator = stream[Symbol.asyncIterator]()
  const first = await iterator.next()
  if (first.done === true) throw new Error('fixture event stream ended before its ready frame')
  const ready: unknown = first.value
  if (!isRecord(ready)) throw new Error('fixture event stream did not open with a frame')
  const clientId = ready['clientId']
  if (ready['type'] !== 'ready' || typeof clientId !== 'string') {
    throw new Error('fixture event stream did not open with a ready frame')
  }
  const frames: Record<string, unknown>[] = []
  const pump = (async () => {
    for (;;) {
      const next = await iterator.next()
      if (next.done === true) return
      if (isRecord(next.value)) frames.push(next.value)
    }
  })()
  return {
    clientId,
    frames: () => frames,
    stop: async () => {
      abort.abort(new Error('fixture event stream closed'))
      await pump
    },
  }
}

async function sendEventResult(
  host: ComposedHost,
  clientId: string,
  eventId: string,
  outcome: { readonly kind: 'next' } | { readonly kind: 'result'; readonly value?: unknown },
): Promise<void> {
  const response = await fetch(`${host.origin}/api/$events/result`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: host.cookie },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: `fixture-${eventId}`,
      method: '$events/result',
      payload: { args: { clientId, eventId, outcome } },
    }),
  })
  expect(response.status).toBe(200)
  const body = await response.json() as {
    readonly result?: { readonly ok?: boolean; readonly error?: { readonly message?: string } }
  }
  if (body.result?.ok !== true) throw new Error(body.result?.error?.message ?? 'fixture event result failed')
}

/** Narrow one frame value to a record of its fields. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function provideBrowserCredentials(ctx: Context): void {
  const records = new Map<unknown, unknown>()
  ctx.provide('credentials', {
    async modifyRecord(
      key: unknown,
      mutate: (current: unknown) => Promise<unknown>,
    ): Promise<unknown> {
      const current = records.get(key)
      const next = await mutate(current)
      if (next !== undefined) records.set(key, next)
      return next ?? current
    },
  } as never)
}

function browserCookie(ctx: Context): string {
  const origin = `http://127.0.0.1:${String(ctx.webServer.port)}`
  const target = new URL(ctx.connection.authenticatedUrl(origin))
  let setCookie: string | undefined
  ctx.connection.authorizeIndex({
    method: 'GET',
    url: `${target.pathname}${target.search}`,
    headers: { host: target.host },
  }, {
    writeHead(_status: number, headers?: Record<string, string>) { setCookie = headers?.['set-cookie'] },
    end() {},
  })
  if (setCookie === undefined) throw new Error('fixture did not receive a browser cookie')
  return setCookie.split(';', 1)[0] as string
}
