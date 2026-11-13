/**
 * Wire-safe approval identifiers and outcome vocabulary, free of
 * cordis/service imports so browser type chains can
 * consume them without loading this package's Context augmentation.
 * @module @deepseek-ai/dsh-user-approval/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { Scoped } from '@deepseek-ai/dsh-scope'
import type { Agent } from '@deepseek-ai/dsh-agent/types'
import type { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type {} from '@deepseek-ai/dsh-session-projection/types'
import type { SessionProjectionSummaryExcluded } from '@deepseek-ai/dsh-session-projection/types'
import type {} from '@deepseek-ai/dsh-typert-protocol'

/**
 * Pairs one `approval/asked` audit event with its `approval/decided`.
 * Service-issued (one fresh id per {@link ApprovalService.request} call).
 */
export type ApprovalRequestId = Branded<'ApprovalRequestId'>

/**
 * Brand a string as an {@link ApprovalRequestId}.
 * @param id - the raw id string to brand.
 * @returns the same string carrying the brand.
 */
export function ApprovalRequestId(id: string): ApprovalRequestId {
  return id as ApprovalRequestId
}

/**
 * Closed approval outcomes: a one-shot grant, explicit rejection, withdrawn
 * request, or unavailable answerer. Callers fail closed on `unavailable`.
 */
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/**
 * Decisions an interactive Client may deliver for a pending request. The
 * late-answer entry accepts this subset of {@link ApprovalOutcome}: a Client
 * never withdraws a request and never decides it unavailable.
 */
export type ApprovalDecision = 'allowed-once' | 'rejected'

/**
 * One request awaiting a decision, as the shared `approvalState` projection
 * publishes it. `displayReason` is absent because localized presentation copy
 * is never persisted; a card rebuilt from the log falls back to `reason`.
 */
export interface PendingApprovalView {
  /** The `approval/asked` identity, paired with the `approval/decided` that will settle it. */
  readonly id: ApprovalRequestId
  /** Tool whose operation awaits the decision. */
  readonly toolName: string
  /** Exact tool call being decided, when the asker had one. */
  readonly callId?: ToolCallId
  /** Human-readable explanation supplied by the asker. */
  readonly reason?: string
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /**
     * Requests awaiting a decision in this Session, in ask order. Excluded
     * from Session summaries: `reason` is unbounded asker text that no list
     * row renders, and an opened Session receives every value anyway.
     */
    approvalState: SessionProjectionSummaryExcluded<PendingApprovalView[]>
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** The named request is not awaiting a decision in this Host. */
    'approval/not-pending': { readonly id: ApprovalRequestId }
    /** Another surface already settled the named request; the first answer won. */
    'approval/already-answered': { readonly id: ApprovalRequestId }
    /** The named request belongs to a different Session than the caller's. */
    'approval/wrong-session': { readonly id: ApprovalRequestId }
    /** The wire carried an outcome outside {@link ApprovalDecision}. */
    'approval/bad-outcome': { readonly outcome: string }
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * An approval question was put to the answerer chain — log-only audit
     * (like `hook/*`; NOT a surface event, carries no `surfaceOp`). `id` pairs
     * it with the `approval/decided` that always follows; `toolName` is the
     * tool the question is about, `callId` the exact tool call when the asker
     * had one, `reason` the asker's human-readable explanation (e.g. a hook's
     * permission-decision reason).
     */
    'approval/asked': {
      id: ApprovalRequestId
      toolName: string
      callId?: ToolCallId
      reason?: string
    }
    /**
     * The outcome of a prior `approval/asked` (same `id`) — log-only audit.
     * Exactly one per ask, appended when the outcome is known: a decision, a
     * cancellation, or the fail-closed `'unavailable'`.
     */
    'approval/decided': {
      id: ApprovalRequestId
      outcome: ApprovalOutcome
    }
  }
}

/** Client-safe payload declared for the approval answerer waterfall. */
export interface ApprovalRequestEvent {
  /** Agent identity projected to the corresponding Client Context in transit. */
  readonly agent: Agent
  /**
   * Audit identity of this ask, so a Client that also rebuilt the request from
   * the `approvalState` projection presents ONE card and answers through the
   * same identity when no live waterfall carries it.
   */
  readonly requestId?: ApprovalRequestId
  /** Tool whose operation requires a decision. */
  readonly toolName: string
  /** Exact tool call being decided, when available. */
  readonly callId?: ToolCallId
  /** Human-readable reason supplied by the asker. */
  readonly reason?: string
  /** Localized presentation only; never persisted in approval audit events. */
  readonly displayReason?: { readonly en: string; readonly [locale: string]: string }
  /** Cancellation lifetime of the pending request. */
  readonly signal?: AbortSignal
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Ask composed answerers for one decision. Return an outcome to claim the
     * request or call `next()` to delegate. Scope-filtered dispatch
     * (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
     * @param req - pending approval request.
     * @mode waterfall
     */
    'approval/request'(
      this: Scoped<Agent>,
      req: ApprovalRequestEvent,
      next: () => Promise<ApprovalOutcome>,
    ): Promise<ApprovalOutcome>
  }
}
