/**
 * Rebuild answerable approval cards from the `approvalState` projection, so a
 * page reload or reconnect keeps a pending decision visible after the live
 * `approval/request` dispatch is gone. One ask owns one card across both
 * sources: the live waterfall adopts a card already rebuilt from the log, and
 * a card whose ask the Host can no longer settle is retired instead of being
 * rebuilt on the next projection update.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { PendingInteractionPublisher } from '@deepseek-ai/dsh-client-ui-session/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ApprovalRequestId, PendingApprovalView } from '@deepseek-ai/dsh-user-approval/types'
import { PendingApproval } from './contract/slots.ts'

/** The Session-projections face this Client reads pending approvals from. */
const PROJECTION = 'approvalState'

/** One published card and the publication holding it in the Session pending set. */
interface Presented {
  readonly pending: PendingApproval
  readonly unpublish: () => void
  /** Set once a live waterfall carries this card; the pending set delegates to it. */
  liveDelegate: (() => Promise<void>) | undefined
}

/**
 * The cards this Client presents, keyed by the ask they answer.
 *
 * Two key sets ride beside the cards. `#projected` holds the asks the
 * projection may reclaim, including adopted ones — a settlement in another
 * browser closes the projection and must remove the card here. `#retired`
 * holds asks this Client already finished, so a projection update that still
 * lists them does not resurrect a card that can no longer be answered.
 */
export class ApprovalCards {
  readonly #cards = new Map<string, Presented>()
  readonly #projected = new Set<string>()
  readonly #retired = new Set<string>()

  /**
   * @param publish - registers one card as the Session's pending interaction.
   */
  constructor(private readonly publish: PendingInteractionPublisher<PendingApproval>) {}

  /**
   * Card identity of one ask.
   * @param sessionId - Session owning the request.
   * @param requestId - the ask's audit identity.
   * @returns the key both presentation paths share.
   */
  static keyOf(sessionId: SessionId, requestId: ApprovalRequestId): string {
    return `${sessionId}:${requestId}`
  }

  /**
   * The card already presenting one ask.
   * @param sessionId - Session owning the request.
   * @param requestId - the ask's audit identity.
   * @returns the presented card, or `undefined` when this Client shows none.
   */
  get(sessionId: SessionId, requestId: ApprovalRequestId): PendingApproval | undefined {
    return this.#cards.get(ApprovalCards.keyOf(sessionId, requestId))?.pending
  }

  /**
   * Whether this Client already finished the ask and must not present it again.
   * @param sessionId - Session owning the request.
   * @param requestId - the ask's audit identity.
   * @returns whether the ask is locally finished.
   */
  retired(sessionId: SessionId, requestId: ApprovalRequestId): boolean {
    return this.#retired.has(ApprovalCards.keyOf(sessionId, requestId))
  }

  /**
   * Publish the one card of an ask. A presented ask keeps its card.
   * @param sessionId - Session owning the request.
   * @param requestId - audit identity, absent when the Host sent none.
   * @param pending - the card to present.
   * @param delegate - live-waterfall delegation; absent for a projection-only card.
   * @returns the card now presenting the ask.
   */
  present(
    sessionId: SessionId,
    requestId: ApprovalRequestId | undefined,
    pending: PendingApproval,
    delegate?: () => Promise<void>,
  ): PendingApproval {
    const key = requestId === undefined ? pending.key : ApprovalCards.keyOf(sessionId, requestId)
    const existing = this.#cards.get(key)
    if (existing !== undefined) return existing.pending
    const unpublish = this.publish(pending, async () => {
      const presented = this.#cards.get(key)
      // The pending set is releasing the card, so the live waterfall behind it
      // ends through the delegate this call runs, not through #forget.
      this.#forget(key, false)
      await presented?.liveDelegate?.()
    })
    this.#cards.set(key, { pending, unpublish, liveDelegate: delegate })
    // Only the projection owns a card it can reclaim. A live dispatch may
    // reach this Client before (or without) the projection frame, so an empty
    // projection must never reclaim it and hand its waterfall back to the Host.
    if (delegate === undefined) this.#projected.add(key)
    void pending.result.then(
      () => {
        // A finished ask stays finished while the projection still lists it.
        if (requestId !== undefined) this.#retired.add(key)
        this.#forget(key)
      },
      () => {
        // A withdrawal (transport abort, delegation) is not an answer: the ask
        // is still pending and must come back when the projection lists it.
        this.#forget(key)
      },
    )
    return pending
  }

  /**
   * Let a live waterfall carry an ask this Client already rebuilt from the
   * projection, so one ask keeps one card and no second delivery races it. The
   * ask stays reclaimable: closing the projection removes this card.
   * @param sessionId - Session owning the request.
   * @param requestId - the ask's audit identity.
   * @param delegate - the waterfall's delegation, run when the card is released.
   */
  adopt(sessionId: SessionId, requestId: ApprovalRequestId, delegate: () => Promise<void>): void {
    const presented = this.#cards.get(ApprovalCards.keyOf(sessionId, requestId))
    if (presented === undefined) return
    presented.liveDelegate = delegate
  }

  /**
   * Retire and drop the card of an ask the Host reports as no longer
   * answerable, so the next projection update does not rebuild it.
   * @param sessionId - Session owning the request.
   * @param requestId - the ask's audit identity.
   */
  discard(sessionId: SessionId, requestId: ApprovalRequestId): void {
    const key = ApprovalCards.keyOf(sessionId, requestId)
    this.#retired.add(key)
    this.#forget(key)
  }

  /**
   * Reconcile reclaimable and retired keys with the asks the projection still
   * lists, dropping every restored card whose ask is gone.
   * @param active - keys of the asks the projection still lists.
   */
  prune(active: ReadonlySet<string>): void {
    for (const key of [...this.#projected]) {
      if (!active.has(key)) this.#forget(key)
    }
    // Retired asks leave the memory once the log no longer lists them.
    for (const key of [...this.#retired]) {
      if (!active.has(key)) this.#retired.delete(key)
    }
  }

  /**
   * Drop one card and stop proposing it.
   * @param key - the ask's card identity.
   * @param releaseLive - whether a live waterfall behind the card must be
   *   released here; the pending-set delegate runs it itself.
   */
  #forget(key: string, releaseLive = true): void {
    const presented = this.#cards.get(key)
    this.#projected.delete(key)
    if (presented === undefined) return
    this.#cards.delete(key)
    presented.unpublish()
    // A waterfall still waiting behind this card has no answer left to carry.
    if (releaseLive) void presented.liveDelegate?.()
  }
}

/**
 * Build the card of one ask restored from the projection. Its answer goes to
 * the Host through the late-answer entry because no live waterfall waits here.
 * A refusal that no retry can fix retires the card: a Host that restarted
 * never re-registered the ask, so every later attempt would fail the same way.
 * @param ctx - Client root carrying the Remote assembly and diagnostics.
 * @param cards - the cards this Client presents.
 * @param sessionId - Session owning the request.
 * @param row - the projected pending request.
 * @param notice - localized diagnostic for a card retired this way.
 * @returns an answerable card.
 */
function restoredCard(
  ctx: ClientContext,
  cards: ApprovalCards,
  sessionId: SessionId,
  row: PendingApprovalView,
  notice: () => string,
): PendingApproval {
  return new PendingApproval(sessionId, {
    requestId: row.id,
    toolName: row.toolName,
    ...row.callId === undefined ? {} : { callId: row.callId },
    ...row.reason === undefined ? {} : { reason: row.reason },
  }, async (decision) => {
    const answered = await ctx.remote.approval.answerLate(sessionId, row.id, decision)
    if (answered.ok) return
    if (answered.error.code === 'approval/not-pending' || answered.error.code === 'approval/wrong-session') {
      cards.discard(sessionId, row.id)
      ctx.logger.warn(`${answered.error.code}: ${notice()}`)
    }
    throw new Error(`${answered.error.code}: ${answered.error.message}`)
  })
}

/**
 * Mirror the pending requests of every bound Session onto cards.
 * @param ctx - Client root carrying Session state and the Remote assembly.
 * @param cards - the cards this Client presents.
 * @returns disposer of the list and projection subscriptions.
 */
export function publishRestoredApprovals(ctx: ClientContext, cards: ApprovalCards): () => void {
  const sessions = ctx.sessions
  const t = ctx.locale.bind('approval')
  const notice = (): string => t('unavailable')
  const stopFaces = new Map<SessionId, () => void>()

  const reconcile = (): void => {
    const bound = new Map(Object.values(sessions.list.getSnapshot().byId).flatMap((summary) => {
      const binding = sessions.binding(summary.id)
      return binding === undefined ? [] : [[summary.id, binding] as const]
    }))
    for (const [sessionId, stop] of stopFaces) {
      if (bound.has(sessionId)) continue
      stop()
      stopFaces.delete(sessionId)
    }
    for (const [sessionId, binding] of bound) {
      if (stopFaces.has(sessionId)) continue
      stopFaces.set(sessionId, binding.session.projections.faceOf(PROJECTION).subscribe(reconcile))
    }
    const active = new Set<string>()
    for (const [sessionId, binding] of bound) {
      const projected = binding.session.projections.faceOf(PROJECTION).getSnapshot() as
        readonly PendingApprovalView[] | undefined
      for (const row of projected ?? []) {
        active.add(ApprovalCards.keyOf(sessionId, row.id))
        if (cards.retired(sessionId, row.id) || cards.get(sessionId, row.id) !== undefined) continue
        cards.present(sessionId, row.id, restoredCard(ctx, cards, sessionId, row, notice))
      }
    }
    cards.prune(active)
  }

  reconcile()
  const stopList = sessions.list.subscribe(reconcile)
  return () => {
    stopList()
    for (const stop of stopFaces.values()) stop()
    stopFaces.clear()
  }
}
