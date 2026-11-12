/**
 * Turn-stop guard: a parent agent may not close a turn while a subagent that
 * settled abnormally in that turn is still unhandled. Configuration and
 * observable behavior live in the package README; rationale lives in the
 * child-failure-reminder Agent Note.
 * @module @deepseek-ai/dsh-child-failure-reminder
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, MessageSource } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { SubagentSettledMessageSource } from '@deepseek-ai/dsh-subagent'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'child-failure-reminder': { kind: 'child-failure-reminder'; form: 'notice'; summary: string }
  }
}

export const name = 'child-failure-reminder'

/**
 * The one stop reason that means a child finished the task it was given. Every
 * other reason — and every reason this build cannot name — leaves work undone.
 */
const NORMAL_STOP_REASON = 'completed'

/**
 * The `SubagentResult['stopReason']` members this build knows. That union is
 * merge-extensible, so a reason outside this list belongs to a backend added by
 * another module; it is reported as abnormal rather than silently as success,
 * matching how `dsh-subagent` summarizes such a settlement.
 */
const KNOWN_STOP_REASONS: readonly string[] = [NORMAL_STOP_REASON, 'error', 'max-tokens', 'aborted', 'refusal']

/** Default abnormal set: every known reason except {@link NORMAL_STOP_REASON}. */
const DEFAULT_STOP_REASONS = KNOWN_STOP_REASONS.filter(reason => reason !== NORMAL_STOP_REASON)

/**
 * Fixed sentences `dsh-subagent` closes a settlement notice with when it has no
 * child text and no diagnostic. They carry no failure detail, so a reminder
 * that would quote the notice's final line skips them.
 */
const NOTICE_BOILERPLATE: ReadonlySet<string> = new Set([
  'It left no closing message.',
  'It sent you a message just before finishing, so its closing message is omitted.',
])

/** `dsh-subagent` opens every settlement summary with the child's model-facing name. */
const SETTLEMENT_PREFIX = /^Background subagent (\S+) /u

/**
 * Plugin config, validated by the same-named schemastery schema plus the
 * load-time checks in `apply` (misconfiguration fails loud: an empty
 * `stopReasons` list, a non-positive `maxPerTurn` or `detailPreviewChars`, or a
 * blank tool name throws at plugin load, never a silent fall-back).
 */
export interface Config {
  /**
   * Stop reasons treated as abnormal, i.e. as an unfinished task that the
   * parent must handle. Defaults to every known reason except `completed`; a
   * reason this build cannot name is abnormal regardless of this list.
   */
  stopReasons?: string[]
  /** Reminders the guard may steer into one turn (default `2`); further abnormal settlements in that turn stay silent. */
  maxPerTurn?: number
  /**
   * Maximum characters of the settlement notice's final line quoted in a
   * reminder (default 500). A diagnostic is `dsh-subagent`'s error code plus
   * message chain, so the cap bounds the reminder without hiding the cause.
   */
  detailPreviewChars?: number
  /**
   * Tool names whose call after a settlement notice counts as the parent
   * handling it (default `['subagent', 'send_message']`). An empty list
   * disables that signal, leaving one reminder per settlement notice.
   */
  dispositionTools?: string[]
}

export const Config: z<Config> = z.object({
  stopReasons: z.array(z.string()).default(DEFAULT_STOP_REASONS),
  maxPerTurn: z.number().default(2),
  detailPreviewChars: z.number().default(500),
  dispositionTools: z.array(z.string()).default(['subagent', 'send_message']),
})

/** One received abnormal settlement that the parent has not yet handled this turn. */
interface Failure {
  /** Model-facing child name, or the settlement notice's sender id when it names none. */
  readonly childName: string
  /** Exact stop reason recorded by the manager. */
  readonly stopReason: string
  /** Final line of the settlement notice, absent when it carries only boilerplate. */
  readonly detail: string | undefined
  /** Turn that received the settlement notice. */
  readonly turn: number
  /** Whether this guard already steered a reminder for this settlement. */
  reminded: boolean
  /** Whether the parent handled the failure with a disposition tool call after the notice. */
  dispositioned: boolean
}

/** One session's settlement bookkeeping for its current turn. */
interface SessionState {
  /** Turn opened by the latest `turn/start`; `0` before the first turn this plugin observes. */
  turn: number
  /** Abnormal settlements received in {@link SessionState.turn}. */
  failures: Failure[]
  /** Reminders this guard already steered into {@link SessionState.turn}. */
  steers: number
}

/**
 * Build the model-visible reminder for one unhandled child failure.
 * @param failure - the settlement the parent must handle.
 * @param detailPreviewChars - cap on the quoted final notice line.
 * @returns the reminder text, naming the child, its stop reason, and the required actions.
 */
function reminderText(failure: Failure, detailPreviewChars: number): string {
  const detail = failure.detail === undefined
    ? []
    : [`Last line of its settlement notice: ${preview(failure.detail, detailPreviewChars)}`]
  return [
    `Subagent "${failure.childName}" did not finish its task (stopReason: ${failure.stopReason}).`,
    ...detail,
    'A sentence in your reply does not resolve it: act on it now, before this turn ends. '
      + 'In your next step, take one of these actions with a tool:',
    '- If the subagent could have written files, commits, or task-board records, inspect those side effects before deciding to rerun it.',
    '- max-tokens or a context-limit failure: re-dispatch with a smaller scope. Do not replay the same prompt unchanged; it hits the same ceiling.',
    '- error: re-dispatch once on a different route — another preset, model, or provider.',
    '- Or finish the work yourself.',
    `- If you are abandoning the task, record \`[DELEGATION-FAILED: ${failure.childName} - <reason>]\` in your reply so the failure stays visible.`,
  ].join('\n')
}

/**
 * Head-truncate the quoted notice line, marking how much was omitted.
 * @param text - the full line.
 * @param cap - maximum characters to keep.
 * @returns the line itself, or its head plus an omission marker.
 */
function preview(text: string, cap: number): string {
  if (text.length <= cap) return text
  return `${text.slice(0, cap)}… (+${text.length - cap} more chars)`
}

/**
 * Read the final line of a settlement notice, which is the manager's diagnostic
 * whenever it recorded one.
 * @param content - the settlement notice's model-visible blocks.
 * @returns that line, or undefined when the notice carries no detail.
 */
function noticeDetail(content: readonly ContentBlock[]): string | undefined {
  // The first text block is the summary the source already carries.
  const rest = content.flatMap(block => block.type === 'text' ? [block.text] : []).slice(1)
  const last = rest.pop()
  return last === undefined || NOTICE_BOILERPLATE.has(last) ? undefined : last
}

/**
 * Read the model-facing child name out of a settlement notice.
 * @param source - the notice's producer source.
 * @returns the child's name, or its session id when the summary names none.
 */
function childNameOf(source: SubagentSettledMessageSource): string {
  return SETTLEMENT_PREFIX.exec(source.summary)?.[1] ?? source.senderSessionId
}

/**
 * Install the guard's listeners.
 * @param ctx - plugin context; listeners are scoped to it and disposed with it.
 * @param config - validated {@link Config}; every field is re-checked fail-loud here.
 */
export function apply(ctx: Context, config: Config): void {
  // schemastery's .default() guarantees the fields are set after validation.
  const stopReasons = config.stopReasons as string[]
  if (stopReasons.length === 0) {
    throw new Error('child-failure-reminder: `stopReasons` must not be empty')
  }
  if (stopReasons.some(reason => reason.length === 0)) {
    throw new Error('child-failure-reminder: `stopReasons` must not contain an empty reason')
  }
  const configuredStopReasons = new Set(stopReasons)
  const knownStopReasons = new Set(KNOWN_STOP_REASONS)
  const maxPerTurn = config.maxPerTurn as number
  if (!Number.isInteger(maxPerTurn) || maxPerTurn < 1) {
    throw new Error(`child-failure-reminder: invalid maxPerTurn ${maxPerTurn} — must be an integer >= 1`)
  }
  const detailPreviewChars = config.detailPreviewChars as number
  if (!Number.isInteger(detailPreviewChars) || detailPreviewChars < 1) {
    throw new Error(`child-failure-reminder: invalid detailPreviewChars ${detailPreviewChars} — must be an integer >= 1`)
  }
  const dispositionTools = config.dispositionTools as string[]
  if (dispositionTools.some(tool => tool.length === 0)) {
    throw new Error('child-failure-reminder: `dispositionTools` must not contain an empty tool name')
  }
  const dispositionNames = new Set(dispositionTools)

  const states = new WeakMap<Session, SessionState>()

  /** Read or start the bookkeeping of one session. */
  function stateOf(session: Session): SessionState {
    let state = states.get(session)
    if (state === undefined) {
      state = { turn: 0, failures: [], steers: 0 }
      states.set(session, state)
    }
    return state
  }

  /** Whether one stop reason leaves the child's task unfinished. */
  function abnormal(stopReason: string): boolean {
    if (stopReason === NORMAL_STOP_REASON) return false
    // A reason this build knows is abnormal only when configured; an unknown one
    // comes from a backend this build cannot interpret, so it counts as failure.
    return configuredStopReasons.has(stopReason) || !knownStopReasons.has(stopReason)
  }

  // Durable log events are the only record of what the parent actually saw: a
  // `user/message` appears once the loop claimed the settlement notice into a
  // step, so an in-flight notice cannot be acted on early.
  ctx.on('session/event', (session, event: SessionEvent) => {
    switch (event.type) {
      case 'turn/start': {
        // A new turn starts clean: earlier settlements were that turn's business,
        // and the per-turn reminder budget resets with it.
        const state = stateOf(session)
        state.turn = event.data.turn
        state.failures = []
        state.steers = 0
        return
      }
      case 'user/message': {
        const source = event.data.source
        if (source.kind !== 'subagent-settled') return
        // A notice written before stop reasons were recorded cannot be classified.
        const stopReason = source.stopReason
        if (stopReason === undefined || !abnormal(stopReason)) return
        const state = stateOf(session)
        state.failures.push({
          childName: childNameOf(source),
          stopReason,
          detail: noticeDetail(event.data.content),
          turn: state.turn,
          reminded: false,
          dispositioned: false,
        })
        return
      }
      case 'tool/call': {
        // Re-dispatching or messaging a child is the parent acting on what it was
        // told. The guard does not read the call's arguments, so one dispatch-level
        // call settles every notice that preceded it.
        if (!dispositionNames.has(event.data.name)) return
        for (const failure of stateOf(session).failures) failure.dispositioned = true
        return
      }
      default:
        return
    }
  })

  // The turn is at its stop boundary: the model owes no response and is about to
  // close. Steering here makes the machine re-read its inbox and run another
  // step, so an unhandled abnormal settlement cannot end the turn as prose.
  ctx.on('agent/turn-stopping', ({ agent, turn }) => {
    const state = stateOf(agent.session)
    if (state.steers >= maxPerTurn) return
    const failure = state.failures.find(candidate =>
      candidate.turn === turn && !candidate.reminded && !candidate.dispositioned)
    if (failure === undefined) return
    failure.reminded = true
    state.steers += 1
    const source: MessageSource = {
      kind: 'child-failure-reminder',
      form: 'notice',
      summary: boundContextSummary(`${failure.childName}: ${failure.stopReason}`),
    }
    agent.steer(createUserMessage({ content: [{ type: 'text', text: reminderText(failure, detailPreviewChars) }], source }))
  })
}
