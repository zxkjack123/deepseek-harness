/**
 * The failure-detail channel of `SubagentResult.diagnostic`: the byte limit
 * every provider must honor, and the renderer local backends use to turn an
 * internal failure into parent-visible text.
 *
 * @module @deepseek-ai/dsh-subagent/diagnostic
 */

import { errorChain, HarnessError } from '@deepseek-ai/dsh-llm'

/** Maximum UTF-8 size of `SubagentResult.diagnostic`. */
export const MAX_SUBAGENT_DIAGNOSTIC_BYTES = 4_096

const DIAGNOSTIC_TRUNCATION_SUFFIX = '\n[diagnostic truncated]'
const utf8Encoder = new TextEncoder()
const utf8Decoder = new TextDecoder()

/**
 * Limit provider-authored failure detail without splitting a UTF-8 sequence.
 * @param diagnostic - safe diagnostic text produced by the provider.
 * @returns the original text, or a visibly truncated value within the limit.
 */
export function limitSubagentDiagnostic(diagnostic: string): string {
  const bytes = utf8Encoder.encode(diagnostic)
  if (bytes.byteLength <= MAX_SUBAGENT_DIAGNOSTIC_BYTES) return diagnostic

  const suffixBytes = utf8Encoder.encode(DIAGNOSTIC_TRUNCATION_SUFFIX).byteLength
  let prefixBytes = MAX_SUBAGENT_DIAGNOSTIC_BYTES - suffixBytes
  while (((bytes[prefixBytes] as number) & 0b1100_0000) === 0b1000_0000) {
    prefixBytes -= 1
  }
  return utf8Decoder.decode(bytes.subarray(0, prefixBytes))
    + DIAGNOSTIC_TRUNCATION_SUFFIX
}

/**
 * Render a local child's failure for its parent.
 *
 * The parent otherwise receives only a category sentence, so the machine
 * code is what lets it tell an exhausted context window from a dead backend
 * and choose between shrinking the task and re-routing it.
 * @param error - the thrown value reported through `agent/error`.
 * @returns the harness code when present, the message chain, and a byte limit.
 */
export function describeSubagentFailure(error: unknown): string {
  const code = error instanceof HarnessError ? `${error.code}: ` : ''
  return limitSubagentDiagnostic(`${code}${errorChain(error)}`)
}
