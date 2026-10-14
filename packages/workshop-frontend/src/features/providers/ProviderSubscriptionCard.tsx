import { useEffect, useRef, useState } from 'react'
import { Button, Dialog } from '@cloudflare/kumo'
import type { RpcStub } from 'capnweb'
import type { ProviderSubscriptionConnectionsApi } from '@gadgets/workshop-shared/provider-connections-api'
import type { ProviderSubscriptionDescriptor } from '@gadgets/workshop-shared/provider-connections'
import { subscriptionErrorMessage } from './subscriptionConnectionFlow'

type Props = { api: RpcStub<ProviderSubscriptionConnectionsApi>; connection: ProviderSubscriptionDescriptor; onReconnect: () => void; onChanged: () => Promise<void> }
/** Show saved association truthfully without offering subscription inference or catalog controls. */
export const ProviderSubscriptionCard = ({ api, connection, onReconnect, onChanged }: Props) => {
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState('')
  const [clock, setClock] = useState(Date.now())
  const epoch = useRef(0)
  const running = useRef(false)
  useEffect(() => { const timer = setInterval(() => setClock(Date.now()), 1000); return () => { clearInterval(timer); ++epoch.current } }, [])
  const run = async (work: () => Promise<unknown>) => {
    if (running.current) return
    running.current = true; const operation = ++epoch.current; setBusy(true); setError('')
    try { await work(); await onChanged(); if (operation === epoch.current) setConfirming(false) }
    catch (caught) { if (operation === epoch.current) setError(subscriptionErrorMessage(caught)) }
    finally { if (operation === epoch.current) { running.current = false; setBusy(false) } }
  }
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
    <p className="mt-3 text-sm text-kumo-default">{status} Inference setup is pending.</p>
    <p className="mt-1 text-sm text-kumo-subtle">Registration: {connection.registration?.status ?? 'none'}.</p>
    {connection.registration?.clientId && <p className="mt-1 break-all text-sm text-kumo-subtle">Public client ID: {connection.registration.clientId}</p>}
    {pending && <div className="mt-3 space-y-3">
      <p className="text-sm text-kumo-subtle">{pending.expiresAt <= clock ? 'Authorization expired. Refresh to clear its exact pending attempt.' : pending.phase === 'issued' ? 'Authorization exchange is in progress; its outcome may be uncertain.' : `Waiting for sign-in until ${new Date(pending.expiresAt).toLocaleTimeString()}.`}</p>
      <Button variant="secondary" className="min-h-11" disabled={busy} onClick={() => void run(() => api.cancelPending(connection.connectionId, pending.attemptId))}>Cancel this pending sign-in</Button>
    </div>}
    <p className="mt-3 text-sm text-kumo-subtle">Allowance and credits are shared and controlled by ChatGPT. No balance or eligibility is confirmed here.</p>
    <a className="mt-2 inline-flex min-h-11 items-center text-kumo-link" href="https://chatgpt.com/settings/usage" target="_blank" rel="noopener noreferrer">Manage usage in ChatGPT</a>
    {error && <p role="alert" className="mt-3 text-sm text-kumo-danger">{error}</p>}
    <p aria-live="polite" className="text-sm text-kumo-subtle">{busy ? 'Updating authorization…' : ''}</p>
    <Dialog.Root open={confirming} onOpenChange={open => { if (!busy) setConfirming(open) }}>
      <Dialog className="responsive-dialog max-md:translate-y-0! max-h-[calc(var(--app-height)-32px)] overflow-y-auto p-6" size="sm">
        <Dialog.Title>Disconnect ChatGPT authorization?</Dialog.Title>
        <p className="mt-3 text-sm text-kumo-subtle">Plexus deletes local authorization first and attempts remote revocation. Inspect provider settings if remote revocation cannot be confirmed.</p>
        <div className="mt-5 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <Button className="min-h-11" variant="secondary" disabled={busy} onClick={() => setConfirming(false)}>Cancel</Button>
          <Button className="min-h-11" variant="primary" loading={busy} disabled={busy} onClick={() => void run(() => api.disconnect(connection.connectionId))}>Disconnect</Button>
        </div>
      </Dialog>
    </Dialog.Root>
  </article>
}
