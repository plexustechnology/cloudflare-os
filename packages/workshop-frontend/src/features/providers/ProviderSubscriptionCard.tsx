import { useEffect, useRef, useState } from 'react'
import { Button, Dialog } from '@cloudflare/kumo'
import type { RpcStub } from 'capnweb'
import type { ProviderSubscriptionConnectionsApi, ProviderSubscriptionDiscovery } from '@gadgets/workshop-shared/provider-connections-api'
import type { ProviderSubscriptionDescriptor } from '@gadgets/workshop-shared/provider-connections'
import { subscriptionErrorMessage } from './subscriptionConnectionFlow'
import { providerErrorMessage } from './providerConnectionFlow'

const modelErrorMessage = (caught: unknown): string => {
  const code = caught instanceof Error ? caught.message : ''
  if (code === 'connection_required') return 'Current authorization is unavailable. Refresh status before choosing a model.'
  if (code === 'usage_limit') return 'Model updates are limited by the app or plan. Inspect Manage usage in ChatGPT.'
  if (['invalid_request', 'reconnect_required', 'connection_forbidden', 'adapter_disabled', 'unsupported_feature', 'rate_limited', 'provider_unavailable'].includes(code)) return providerErrorMessage(caught)
  return 'The model update could not be confirmed. Refresh status and the model catalog, then choose a model explicitly.'
}

type Authority = Pick<ProviderSubscriptionDescriptor, 'connectionId' | 'generation' | 'credentialRevision' | 'status'>
type Feedback = { source: RpcStub<ProviderSubscriptionConnectionsApi>; authority: Authority } &
  ({ kind: 'selected'; showWelcome: boolean } | { kind: 'error'; message: string })
const authorityOf = ({ connectionId, generation, credentialRevision, status }: ProviderSubscriptionDescriptor): Authority =>
  ({ connectionId, generation, credentialRevision, status })
const sameAuthority = (left: Authority, right: Authority) => left.connectionId === right.connectionId &&
  left.generation === right.generation && left.credentialRevision === right.credentialRevision && left.status === right.status

type Props = { api: RpcStub<ProviderSubscriptionConnectionsApi>; connection: ProviderSubscriptionDescriptor; onReconnect: () => void; onChanged: () => Promise<void>; onModelsChanged?: () => Promise<void> }
/** Explicit grant-scoped catalog selection; local metadata never implies provider eligibility. */
export const ProviderSubscriptionCard = ({ api, connection, onReconnect, onChanged, onModelsChanged }: Props) => {
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [feedback, setFeedback] = useState<Feedback>()
  const [discovery, setDiscovery] = useState<ProviderSubscriptionDiscovery>()
  const [clock, setClock] = useState(Date.now())
  const epoch = useRef(0)
  const running = useRef(false)
  const latestApi = useRef(api)
  latestApi.current = api
  const latest = useRef(connection)
  latest.current = connection
  const authority = authorityOf(connection)
  const ownsOperation = (operation: number) => operation === epoch.current && latestApi.current === api
  const isCurrent = (operation: number) => ownsOperation(operation) && sameAuthority(authority, latest.current)
  const visibleFeedback = feedback?.source === api && sameAuthority(feedback.authority, authority) ? feedback : undefined
  const error = visibleFeedback?.kind === 'error' ? visibleFeedback.message : ''
  const notice = visibleFeedback?.kind === 'selected' ? 'Model added. Choose it explicitly in your private chat.' : ''
  const welcome = visibleFeedback?.kind === 'selected' && visibleFeedback.showWelcome
  const setWelcome = (open: boolean) => setFeedback(previous => previous?.kind === 'selected' ? { ...previous, showWelcome: open } : previous)
  useEffect(() => { running.current = false; setBusy(false); setDiscovery(undefined); setFeedback(undefined); setConfirming(false); const timer = setInterval(() => setClock(Date.now()), 1000); return () => { clearInterval(timer); ++epoch.current } }, [api])
  const run = async (work: (capability: RpcStub<ProviderSubscriptionConnectionsApi>, operation: number) => Promise<ProviderSubscriptionDescriptor | void>, context: 'authorization' | 'model' = 'authorization') => {
    if (running.current) return
    running.current = true; const operation = ++epoch.current; setBusy(true); setFeedback(undefined)
    let capability: RpcStub<ProviderSubscriptionConnectionsApi> | undefined
    let handoff: Authority | undefined
    const mayPublish = () => ownsOperation(operation) && (sameAuthority(authority, latest.current) ||
      handoff !== undefined && sameAuthority(handoff, latest.current))
    try {
      capability = api.dup()
      const result = await work(capability, operation)
      if (!isCurrent(operation)) return
      // Only a result received under the original authority may carry this operation's renewal.
      if (result?.connectionId === authority.connectionId) handoff = authorityOf(result)
      await onChanged()
      if (mayPublish()) setConfirming(false)
    } catch (caught) {
      if (mayPublish()) setFeedback({ source: api, authority: authorityOf(latest.current), kind: 'error', message: context === 'model' ? modelErrorMessage(caught) : subscriptionErrorMessage(caught) })
    } finally { capability?.[Symbol.dispose](); if (ownsOperation(operation)) { running.current = false; setBusy(false) } }
  }
  const catalog = discovery?.connection.generation === connection.generation && discovery.connection.credentialRevision === connection.credentialRevision ? discovery.catalog : undefined
  const selectable = connection.inferenceEnabled === true && connection.status === 'pending' && connection.credentialConfigured &&
    connection.registration?.status === 'verified' && !connection.pendingAuthorization && catalog?.status === 'fresh' &&
    catalog.fetchedAt !== null && catalog.fetchedAt <= clock && clock - catalog.fetchedAt < 300000
  const refreshCatalog = () => run(async (capability, operation) => {
    const result = await capability.discover(connection.connectionId)
    if (isCurrent(operation)) { setDiscovery(result); setClock(Date.now()); return result.connection }
  }, 'model')
  const choose = (model: string) => run(async (capability, operation) => {
    if (!selectable) return
    const result = await capability.selectModel(connection.connectionId, connection.generation, connection.credentialRevision, model)
    if (!isCurrent(operation)) return
    setFeedback({ source: api, authority, kind: 'selected', showWelcome: result.showPlanWelcome })
    await onModelsChanged?.()
  }, 'model')
  const pending = connection.pendingAuthorization
  const status = connection.status === 'disabled' ? 'Disabled locally.' : connection.status === 'reconnect-required' ? 'Reconnect required.' :
    connection.status === 'plan-disabled' ? 'Authorization saved. ChatGPT plan access was not granted.' : connection.credentialConfigured ? 'Authorization saved.' : 'No authorization saved yet.'
  return <article className="min-w-0 rounded-xl border border-kumo-line bg-kumo-base p-4">
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0"><h3 className="break-words text-sm font-semibold text-kumo-default">{connection.label}</h3><p className="mt-1 text-sm text-kumo-subtle">ChatGPT plan and credits</p></div>
      <div className="flex flex-col gap-3 sm:flex-row">
        <Button variant="secondary" className="min-h-11" disabled={busy || !!pending} onClick={onReconnect}>Reconnect</Button>
        <Button variant="secondary" className="min-h-11" disabled={busy || connection.status === 'disabled'} onClick={() => setConfirming(true)}>Disconnect</Button>
      </div>
    </div>
    <p className="mt-3 text-sm text-kumo-default">{status} {connection.inferenceEnabled === true ? "Personal inference is enabled locally; model eligibility is unverified." : "Personal inference is unavailable in this deployment."}</p>
    <p className="mt-1 text-sm text-kumo-subtle">Registration: {connection.registration?.status ?? 'none'}.</p>
    {connection.registration?.clientId && <p className="mt-1 break-all text-sm text-kumo-subtle">Public client ID: {connection.registration.clientId}</p>}
    {pending && <div className="mt-3 space-y-3">
      <p className="text-sm text-kumo-subtle">{pending.expiresAt <= clock ? 'Authorization expired. Refresh to clear its exact pending attempt.' : pending.phase === 'issued' ? 'Authorization exchange is in progress; its outcome may be uncertain.' : `Waiting for sign-in until ${new Date(pending.expiresAt).toLocaleTimeString()}.`}</p>
      <Button variant="secondary" className="min-h-11" disabled={busy} onClick={() => void run(capability => capability.cancelPending(connection.connectionId, pending.attemptId))}>Cancel this pending sign-in</Button>
    </div>}
    {connection.lastSuccessfulInference?.generation === connection.generation && <p className="mt-2 break-words text-sm text-kumo-subtle">Last successful model: {connection.lastSuccessfulInference.model}.</p>}
    <div className="mt-4"><Button variant="secondary" className="min-h-11" disabled={busy || !!pending || connection.status !== 'pending' || !connection.credentialConfigured} onClick={() => void refreshCatalog()}>Refresh model catalog</Button></div>
    <p className="mt-2 text-sm text-kumo-subtle">Model catalog: {catalog ? catalog.status === 'fresh' && !selectable && catalog.fetchedAt !== null && clock - catalog.fetchedAt >= 300000 ? 'stale' : catalog.status : 'unknown'}{catalog?.fetchedAt ? ` · fetched ${new Date(catalog.fetchedAt).toLocaleTimeString()}` : ''}.</p>
    {catalog?.error && <p role="alert" className="mt-2 text-sm text-kumo-danger">{catalog.error === 'usage_limit' ? 'Model discovery is limited by the app or plan.' : modelErrorMessage(new Error(catalog.error))}</p>}
    {catalog?.error === 'usage_limit' && <a className="inline-flex min-h-11 items-center text-kumo-link" href="https://chatgpt.com/settings/usage" target="_blank" rel="noopener noreferrer">Manage usage</a>}
    {catalog && !catalog.models.length && <p className="mt-2 text-sm text-kumo-subtle">No available models. Refresh later or reconnect.</p>}
    {catalog && catalog.models.length > 0 && <ul className="mt-3 space-y-3">{catalog.models.map(model => <li key={model.id} className="flex min-w-0 flex-col gap-3 rounded-lg bg-kumo-tint p-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0"><p className="break-words text-sm text-kumo-default">{model.name}</p><p className="text-xs text-kumo-subtle">Image and reasoning support unverified.</p></div>
      <Button variant="secondary" className="min-h-11 shrink-0" disabled={busy || !selectable} aria-label={`Choose ${model.name}`} onClick={() => void choose(model.model)}>Choose model</Button>
    </li>)}</ul>}
    {catalog && !selectable && <p className="mt-2 text-sm text-kumo-subtle">Choosing requires a fresh catalog, current authorization and enabled personal inference.</p>}
    <p className="mt-3 text-sm text-kumo-subtle">Plexus checks completed output limits; these do not cap provider generation or charges.</p>
    <p className="mt-3 text-sm text-kumo-subtle">Allowance and credits are shared and controlled by ChatGPT. No balance or eligibility is confirmed here.</p>
    <a className="mt-2 inline-flex min-h-11 items-center text-kumo-link" href="https://chatgpt.com/settings/usage" target="_blank" rel="noopener noreferrer">Manage usage in ChatGPT</a>
    {error && <p role="alert" className="mt-3 text-sm text-kumo-danger">{error}</p>}
    <p aria-live="polite" className="text-sm text-kumo-subtle">{busy ? 'Updating connection…' : notice}</p>
    <Dialog.Root open={welcome} onOpenChange={setWelcome}>
      <Dialog className="responsive-dialog max-md:translate-y-0! max-h-[calc(var(--app-height)-32px)] overflow-y-auto p-6" size="sm">
        <Dialog.Title>You’re using your ChatGPT plan</Dialog.Title>
        <p className="mt-3 text-sm text-kumo-subtle">Eligible requests use your ChatGPT plan and available credits. Allowance is shared and controlled by ChatGPT; model selection does not confirm eligibility.</p>
        <a className="mt-3 inline-flex min-h-11 items-center text-kumo-link" href="https://chatgpt.com/settings/usage" target="_blank" rel="noopener noreferrer">Manage usage</a>
        <div className="mt-4 flex justify-end"><Button className="min-h-11" variant="primary" onClick={() => setWelcome(false)}>Got it</Button></div>
      </Dialog>
    </Dialog.Root>
    <Dialog.Root open={confirming} onOpenChange={open => { if (!busy) setConfirming(open) }}>
      <Dialog className="responsive-dialog max-md:translate-y-0! max-h-[calc(var(--app-height)-32px)] overflow-y-auto p-6" size="sm">
        <Dialog.Title>Disconnect ChatGPT authorization?</Dialog.Title>
        <p className="mt-3 text-sm text-kumo-subtle">Plexus deletes local authorization first and attempts remote revocation. Inspect provider settings if remote revocation cannot be confirmed.</p>
        <div className="mt-5 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <Button className="min-h-11" variant="secondary" disabled={busy} onClick={() => setConfirming(false)}>Cancel</Button>
          <Button className="min-h-11" variant="primary" loading={busy} disabled={busy} onClick={() => void run(capability => capability.disconnect(connection.connectionId))}>Disconnect</Button>
        </div>
      </Dialog>
    </Dialog.Root>
  </article>
}
