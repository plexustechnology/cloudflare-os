import type { RpcStub } from 'capnweb'
import type { ProviderSubscriptionAttempt, ProviderSubscriptionConnectionsApi, ProviderSubscriptionHandoff, ProviderSubscriptionInput } from '@gadgets/workshop-shared/provider-connections-api'
import type { ProviderSubscriptionDescriptor } from '@gadgets/workshop-shared/provider-connections'

/** Fixed subscription guidance without raw RPC, provider or browser diagnostics. */
export const subscriptionErrorMessage = (error: unknown): string => {
  const code = error instanceof Error ? error.message : ''
  if (code === 'expired') return 'Authorization expired. Inspect status and start a fresh sign-in.'
  if (code === 'adapter_disabled' || code === 'connection_forbidden') return 'Subscription authorization is unavailable to this account.'
  if (code === 'reconnect_required') return 'The authorization changed. Refresh status before starting a fresh sign-in.'
  if (code === 'helper_used') return 'Restart the helper for a fresh sign-in.'
  return 'The outcome is unknown. Refresh status before starting a fresh sign-in.'
}

/** Shell-quote a canonical origin for the owner-run helper command. */
export const subscriptionHelperCommand = (origin: string): string => `pnpm provider:subscription-helper --origin '${origin.replace(/'/g, "'\\''")}'`

/** Fixed local bootstrap carries only transient pairing/public setup in its fragment. */
export const subscriptionManualLink = (origin: string, port: number, pairing: string, handoff: ProviderSubscriptionHandoff): string =>
  `http://127.0.0.1:${port}/setup#${encodeURIComponent(JSON.stringify({ pairing, origin, ...handoff }))}`

const localRequest = async (port: number, pairing: string, route: string, body?: unknown, signal?: AbortSignal): Promise<Record<string, unknown>> => {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { 'x-plexus-pairing': pairing, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', redirect: 'error',
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000),
  })
  if (!response.ok || !response.body) throw new Error('helper_unavailable')
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0
  try {
    for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > 14000) throw new Error('helper_unavailable'); chunks.push(next.value) }
    const bytes = new Uint8Array(size); let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('helper_unavailable')
    return value as Record<string, unknown>
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock() }
}

type Callbacks = { onReady: (handoff: ProviderSubscriptionHandoff, automatic: boolean) => void; onCompleting: () => void }
type SubscriptionOutcome = { kind: 'saved'; connection: ProviderSubscriptionDescriptor } |
  { kind: 'declined'; connection: ProviderSubscriptionDescriptor } |
  { kind: 'cancelled'; connection?: ProviderSubscriptionDescriptor } |
  { kind: 'error'; message: string; connection?: ProviderSubscriptionDescriptor }

/** Own one exact capability across helper polling/manual recovery; cloud completion is never replayed. */
export const startSubscriptionConnection = (
  capability: RpcStub<ProviderSubscriptionConnectionsApi>, input: ProviderSubscriptionInput,
  existing: ProviderSubscriptionDescriptor | undefined, port: number, pairing: string, callbacks: Callbacks,
) => {
  let api: RpcStub<ProviderSubscriptionConnectionsApi>
  try { api = capability.dup() }
  catch { return { cancel: () => Promise.resolve(undefined), submitManual: (_text: string) => {},
    completion: Promise.resolve<SubscriptionOutcome>({ kind: 'error', message: subscriptionErrorMessage(undefined) }) } }
  const controller = new AbortController()
  let attempt: RpcStub<ProviderSubscriptionAttempt> | undefined
  let handoff: ProviderSubscriptionHandoff | undefined
  let cancelled = false, submitted = false
  let manualResolve: ((text: string) => void) | undefined
  let cancellation: Promise<ProviderSubscriptionDescriptor | undefined> | undefined
  let intentTimer: ReturnType<typeof setTimeout> | undefined
  const cancel = (): Promise<ProviderSubscriptionDescriptor | undefined> => {
    cancelled = true; controller.abort(); manualResolve?.('')
    if (handoff) void localRequest(port, pairing, '/cancel', { attemptId: handoff.attemptId }).catch(() => {})
    if (attempt) cancellation ??= (async () => await attempt!.cancel())().catch(() => undefined)
    return cancellation ?? Promise.resolve(undefined)
  }
  const cancelledOutcome = async (): Promise<SubscriptionOutcome> => {
    // Before retaining an intent no OAuth begin was sent. Afterwards only an authoritative reply
    // confirms cancellation; local abort/disposal cannot establish delivery to the protected store.
    if (!attempt) return { kind: 'cancelled' }
    const current = await cancel()
    return current ? { kind: 'cancelled', connection: current }
      : { kind: 'error', message: subscriptionErrorMessage(undefined) }
  }
  const submitManual = (text: string) => {
    if (!submitted && !cancelled && handoff && text.length <= 12000 && /^[\x20-\x7e]+$/.test(text)) manualResolve?.(text)
  }
  const completion = (async (): Promise<SubscriptionOutcome> => {
    try {
      let automatic = true
      try { const health = await localRequest(port, pairing, '/health', undefined, controller.signal); if (health.ready !== true || health.port !== port) throw new Error('helper_used') }
      catch (error) { if (error instanceof Error && error.message === 'helper_used') throw error; automatic = false }
      if (cancelled) return { kind: 'cancelled' as const }
      const connection = existing ?? await api.reserve(input)
      if (cancelled) return { kind: 'cancelled' as const }
      using prepared = api.prepare(connection.connectionId, connection.generation, input)
      attempt = prepared.dup()
      if (cancelled) return cancelledOutcome()
      const begun = attempt.begin(port)
      if (cancelled) void cancel()
      handoff = await begun
      if (cancelled) return cancelledOutcome()
      const manual = new Promise<string>(resolve => { manualResolve = resolve })
      intentTimer = setTimeout(() => { controller.abort(); manualResolve?.('') }, Math.max(0, handoff.expiresAt - Date.now()))
      if (automatic) {
        try { await localRequest(port, pairing, '/setup', handoff, controller.signal) } catch { automatic = false }
      }
      if (cancelled) return cancelledOutcome()
      callbacks.onReady(handoff, automatic)
      const polling = (async () => {
        if (!automatic) return manual
        while (!controller.signal.aborted && Date.now() < handoff!.expiresAt) {
          try {
            const result = await localRequest(port, pairing, '/result', undefined, controller.signal)
            if (typeof result.capsule === 'string' && result.capsule.length <= 12000) return result.capsule
          } catch { if (!controller.signal.aborted) { callbacks.onReady(handoff!, false); return manual } }
          await new Promise<void>(resolve => {
            const timer = setTimeout(done, 1000)
            function done() { clearTimeout(timer); controller.signal.removeEventListener('abort', done); resolve() }
            controller.signal.addEventListener('abort', done, { once: true })
          })
        }
        return ''
      })()
      const text = await Promise.race([manual, polling])
      if (cancelled) return cancelledOutcome()
      if (!text || Date.now() >= handoff.expiresAt) throw new Error('expired')
      submitted = true; controller.abort(); callbacks.onCompleting()
      const result = await attempt.complete(text)
      if (cancelled) return cancelledOutcome()
      return { kind: result.outcome === 'denied' ? 'declined' : 'saved', connection: result.connection }
    } catch (error) {
      const wasCancelled = cancelled
      if (wasCancelled) return cancelledOutcome()
      const current = attempt ? await cancel() : undefined
      if (attempt && !current) return { kind: 'error', message: subscriptionErrorMessage(undefined) }
      return { kind: 'error' as const, message: subscriptionErrorMessage(error), connection: current }
    } finally {
      controller.abort(); clearTimeout(intentTimer); manualResolve = undefined; handoff = undefined
      await cancellation; attempt?.[Symbol.dispose](); api[Symbol.dispose]()
    }
  })()
  return { cancel, submitManual, completion }
}
