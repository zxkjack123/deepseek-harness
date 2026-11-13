/** Browser approval consumer over the scoped Remote Event waterfall and the recoverable `approvalState` projection. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type { ComposerChainProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { PendingInteractionPublisher } from '@deepseek-ai/dsh-client-ui-session/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TypertClientEventListener } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ShortcutCommandId } from '@deepseek-ai/dsh-client-shortcuts/client'
import { ApprovalCard } from './ApprovalCard.tsx'
import { ApprovalPanel } from './ApprovalPanel.tsx'
import { ApprovalCards, publishRestoredApprovals } from './restore.ts'
import { PendingApproval } from './contract/slots.ts'
import { en, ja, es, fr, de, ru, pt, zh } from './locales.ts'

export type {
  ApprovalCardInput,
  ApprovalComposerProps,
  ApprovalDecision,
  ApprovalDetailOwnerProps,
  ApprovalPresentationRequest,
  PendingApproval,
} from './contract/slots.ts'
export type { ApprovalKey } from './locales.ts'

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap {
    /** An approval card holding its Session generation until the user answers or its request ends. */
    approval: unknown
  }
}

/** Required services: Agent scopes, Remote Events and the approval answer entry, Session UI, Slot registry, and copy. */
export const inject = ['sessions', 'remote', 'remote.approval', 'uiSession', 'slots', 'locale']

const NS = 'approval'

type ApprovalListener = TypertClientEventListener<'approval/request'>
type ClientApprovalRequest = Parameters<ApprovalListener>[0]
type ClientApprovalNext = Parameters<ApprovalListener>[1]
type ClientApprovalOutcome = Awaited<ReturnType<ApprovalListener>>

/** One resolved approval home: the Session identity plus a generation retained for this request. */
interface ApprovalScope {
  readonly sessionId: SessionId
  /** Releases a generation materialized here; absent when the dispatch subject already carried one. */
  readonly release: (() => void) | undefined
}

/* jscpd:ignore-start -- Approval and Question intentionally mirror one Remote waterfall lifecycle. */
/**
 * Resolve the Session an approval card belongs to instead of dropping a request whose dispatch
 * subject carries no Agent tag. The transport resolves tagged subjects already; an untagged one
 * still names the Agent it answers for, and retaining that identity materializes its generation.
 * @param ctx - Client root context.
 * @param owner - context the forwarded waterfall dispatched on.
 * @param request - forwarded approval request.
 * @returns the Session and an optional retained generation, or undefined without a reachable Agent identity.
 */
function resolveApprovalScope(
  ctx: ClientContext,
  owner: ClientContext,
  request: ClientApprovalRequest,
): ApprovalScope | undefined {
  const dispatched = ctx.sessions.scopeOf(owner)
  if (dispatched !== undefined) return { sessionId: dispatched, release: undefined }
  // The request names the Agent this waterfall answers for, so a transport that projects that
  // Agent without tagging the dispatch subject still resolves through it.
  const projected = ctx.sessions.scopeOf(request.agent)
  if (projected === undefined) return undefined
  const reference = ctx.sessions.retain(projected, { source: 'approval' })
  return { sessionId: reference.sessionId, release: () => { reference.release() } }
}

/** Present one request until the user answers or its lifetime ends. */
async function answerApproval(
  ctx: ClientContext,
  cards: ApprovalCards,
  owner: ClientContext,
  request: ClientApprovalRequest,
  next: ClientApprovalNext,
  registerPendingInteraction: PendingInteractionPublisher<PendingApproval>,
): Promise<ClientApprovalOutcome> {
  const scope = resolveApprovalScope(ctx, owner, request)
  if (scope === undefined) {
    console.error(
      '[ui-approval] approval request reached no Agent scope; delegating to the Host chain:',
      request.toolName,
    )
    return next()
  }
  const { sessionId } = scope
  const requestId = request.requestId
  const restored = requestId === undefined ? undefined : cards.get(sessionId, requestId)
  if (requestId !== undefined && restored !== undefined) {
    // The projection already presented this ask: this waterfall rides that card
    // instead of publishing a second one.
    restored.attachLive(request.signal)
    cards.adopt(sessionId, requestId, () => {
      restored.delegate()
      return Promise.resolve()
    })
    try {
      return await restored.result
    } catch (error) {
      if (restored.isDelegation(error)) return await next()
      throw error
    } finally {
      scope.release?.()
    }
  }
  const pending = new PendingApproval(sessionId, {
    ...requestId === undefined ? {} : { requestId },
    toolName: request.toolName,
    ...(request.callId === undefined
      ? {}
      : { callId: request.callId }),
    ...(request.reason === undefined ? {} : { reason: request.reason }),
    ...(request.displayReason === undefined ? {} : { displayReason: request.displayReason }),
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  })
  const completed = Promise.withResolvers<void>()
  const settle = async (): Promise<ClientApprovalOutcome> => {
    try {
      return await pending.result
    } catch (error) {
      if (pending.isDelegation(error)) return await next()
      throw error
    }
  }
  if (requestId === undefined) {
    // A Host that names no ask leaves nothing to reconcile against.
    const remove = registerPendingInteraction(pending, async () => {
      pending.delegate()
      await completed.promise
    })
    try {
      return await settle()
    } finally {
      remove()
      completed.resolve()
      scope.release?.()
    }
  }
  // The card is published once for every source: answering it forgets the
  // publication, so the waterfall needs no teardown of its own.
  cards.present(sessionId, requestId, pending, async () => {
    pending.delegate()
    await completed.promise
  })
  try {
    return await settle()
  } finally {
    completed.resolve()
    scope.release?.()
  }
}
/* jscpd:ignore-end */

/**
 * Install approval copy, the scoped waterfall consumer, and the projection
 * reconciliation that keeps a pending decision answerable across reloads.
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'ui-approval: dictionaries')
  ctx.inject(['shortcuts'], (scope) => {
    const t = ctx.locale.bind(NS)
    scope.effect(() => scope.shortcuts.registerFixed({
      id: 'approval.allow' as ShortcutCommandId, label: () => t('allow'), keys: ['Enter'], bindings: [{ code: 'Enter', modifiers: [] }], group: 'approval',
    }), 'ui-approval: fixed allow reference')
    scope.effect(() => scope.shortcuts.registerFixed({
      id: 'approval.reject' as ShortcutCommandId, label: () => t('reject'), keys: ['Esc'], bindings: [{ code: 'Escape', modifiers: [] }], group: 'approval',
    }), 'ui-approval: fixed reject reference')
  })
  const registerPendingInteraction = ctx.uiSession.registerPendingInteraction<PendingApproval>(
    () => 0,
  )
  const cards = new ApprovalCards(registerPendingInteraction)
  ctx.effect(() => publishRestoredApprovals(ctx, cards), 'ui-approval: restored cards')
  ctx.slots.registerFactory({
    name: 'conversation.approval.card', scope: 'session', locale: NS,
    children: { 'conversation.approval.detail': { kind: 'single', scope: 'session' } },
  }, ApprovalCard)
  ctx.slots.inject('conversation.composer', () => ctx.slots.register({
    name: 'conversation.composer',
    priority: 1,
    select: ({ pendingInteraction }: ComposerChainProps): PendingApproval | null =>
      pendingInteraction instanceof PendingApproval ? pendingInteraction : null,
    locale: NS,
    inject: () => ({
      resolveReason: (reason: NonNullable<PendingApproval['displayReason']>) => ctx.locale.resolveText(reason),
    }),
  }, ApprovalPanel))
  ctx.remote.$on('approval/request', function (request, next) {
    return answerApproval(ctx, cards, this, request, next, registerPendingInteraction)
  })
}
