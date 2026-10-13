import { useEffect, useRef, useState } from 'react'
import { Button, Dialog, useKumoToastManager } from '@cloudflare/kumo'
import type { RpcStub } from 'capnweb'
import type { ProviderConnectionsApi } from '@gadgets/workshop-shared/provider-connections-api'
import type { ProviderConnectionDescriptor, ProviderConnectionCatalog } from '@gadgets/workshop-shared/provider-connections'
import { canSelectProviderModel, providerErrorMessage } from './providerConnectionFlow'

type Props = {
  api: RpcStub<ProviderConnectionsApi>
  connection: ProviderConnectionDescriptor
  onReconnect: () => void
  onChanged: () => Promise<void>
  onModelAdded: () => Promise<void>
}

/** Sanitized connection controls; a catalog or configured key never implies readiness. */
export const ProviderConnectionCard = ({ api, connection, onReconnect, onChanged, onModelAdded }: Props) => {
  const [catalog, setCatalog] = useState<{ generation: number; value: ProviderConnectionCatalog }>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [clock, setClock] = useState(Date.now())
  const epoch = useRef(0)
  const inFlight = useRef(false)
  const toasts = useKumoToastManager()
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 30_000)
    return () => { clearInterval(timer); ++epoch.current }
  }, [])
  const run = async (work: () => Promise<void>) => {
    if (inFlight.current) return
    inFlight.current = true
    const operation = ++epoch.current
    setBusy(true)
    setError('')
    try { await work() }
    catch (caught) { if (operation === epoch.current) setError(providerErrorMessage(caught)) }
    finally { if (operation === epoch.current) { inFlight.current = false; setBusy(false) } }
  }
  const refreshCatalog = () => run(async () => {
    const operation = epoch.current
    const generation = connection.generation
    const value = await api.discover(connection.connectionId)
    const current = await api.status(connection.connectionId)
    if (operation !== epoch.current) return
    setClock(Date.now())
    if (current.generation === generation) setCatalog({ generation, value })
    else setCatalog(undefined)
    await onChanged()
  })
  const select = (model: string) => run(async () => {
    const operation = epoch.current
    await api.selectModel(connection.connectionId, connection.generation, model)
    if (operation !== epoch.current) return
    await onModelAdded()
    if (operation === epoch.current) toasts.add({ title: 'Model added. Choose it in your chat.', variant: 'success' })
  })
  const disconnect = () => run(async () => {
    const operation = epoch.current
    await api.disconnect(connection.connectionId)
    if (operation !== epoch.current) return
    setCatalog(undefined)
    setConfirming(false)
    await onChanged()
  })
  const available = canSelectProviderModel(connection, catalog, clock)
  const usableCatalog = catalog?.generation === connection.generation ? catalog.value : undefined
  const freshness = usableCatalog?.status === 'fresh' && usableCatalog.fetchedAt !== null && clock - usableCatalog.fetchedAt >= 300_000
    ? 'stale' : usableCatalog?.status ?? 'unknown'
  const status = connection.status === 'disabled' ? 'Disabled — reconnect to use this connection.'
    : connection.status === 'reconnect-required' ? 'Reconnect required — replace your key and choose the model again.'
    : connection.credentialConfigured ? 'Configured — model not yet validated' : 'No key configured — reconnect to finish setup.'
  return (
    <article className="min-w-0 rounded-xl border border-kumo-line bg-kumo-base p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h3 className="break-words text-sm font-semibold text-kumo-default">{connection.label}</h3>
          <p className="mt-1 text-sm text-kumo-subtle">OpenAI <span className="ml-1 rounded-full bg-kumo-tint px-2 py-1 text-xs">OpenAI API billing</span></p>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row">
          <Button variant="secondary" className="min-h-11" disabled={busy} onClick={onReconnect}>Reconnect</Button>
          <Button variant="secondary" className="min-h-11" disabled={busy || connection.status === 'disabled'} onClick={() => setConfirming(true)}>Disconnect</Button>
        </div>
      </div>
      <p className="mt-3 text-sm text-kumo-default">{status}</p>
      <p className="mt-1 text-sm text-kumo-subtle">Credential: {connection.credentialConfigured ? 'configured' : 'not configured'}. Model catalog: {freshness}.</p>
      {connection.lastSuccessfulInference?.generation === connection.generation && <p className="mt-1 break-words text-sm text-kumo-subtle">Last successful model: {connection.lastSuccessfulInference.model}</p>}
      {connection.inferenceEnabled !== true && <p className="mt-3 text-sm text-kumo-subtle">Personal inference is unavailable in this deployment. You can manage your connection.</p>}
      <div className="mt-4">
        <Button variant="secondary" className="min-h-11" disabled={busy || !connection.credentialConfigured || connection.status !== 'pending'} onClick={() => void refreshCatalog()}>Refresh model catalog</Button>
      </div>
      {usableCatalog?.error && <p className="mt-3 text-sm text-kumo-danger">{providerErrorMessage(new Error(usableCatalog.error))}</p>}
      {usableCatalog && usableCatalog.models.length === 0 && <p className="mt-3 text-sm text-kumo-subtle">No available models in this catalog. Refresh later or reconnect.</p>}
      {usableCatalog && usableCatalog.models.length > 0 && <ul className="mt-3 space-y-3">
        {usableCatalog.models.map(model => <li key={model.id} className="flex min-w-0 flex-col gap-3 rounded-lg bg-kumo-tint p-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0"><p className="break-all text-sm text-kumo-default">{model.name}</p><p className="text-xs text-kumo-subtle">Image and reasoning support unverified.</p></div>
          <Button variant="secondary" className="min-h-11 shrink-0" disabled={busy || !available} onClick={() => void select(model.model)}>Use model</Button>
        </li>)}
      </ul>}
      {usableCatalog && !available && <p className="mt-3 text-sm text-kumo-subtle">Choosing a model requires a fresh catalog, a current configured connection and enabled personal inference.</p>}
      <p aria-live="polite" className="mt-3 text-sm text-kumo-subtle">{busy ? 'Updating connection…' : ''}</p>
      {error && <p role="alert" className="mt-3 text-sm text-kumo-danger">{error}</p>}
      <Dialog.Root open={confirming} onOpenChange={open => { if (!busy) setConfirming(open) }}>
        <Dialog className="responsive-dialog max-md:translate-y-0! [@media(max-height:520px)]:translate-y-0! max-h-[calc(var(--app-height)-32px)] overflow-y-auto overscroll-contain p-6" size="sm">
          <Dialog.Title className="text-lg font-semibold">Disconnect OpenAI API?</Dialog.Title>
          <p className="mt-3 text-sm text-kumo-subtle">This disables the connection locally and stops running chats. No other provider or billing route will be selected automatically. Revoke the API key separately in OpenAI if needed.</p>
          <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <Button className="min-h-11" variant="secondary" disabled={busy} onClick={() => setConfirming(false)}>Cancel</Button>
            <Button className="min-h-11" variant="primary" disabled={busy} loading={busy} onClick={() => void disconnect()}>Disconnect</Button>
          </div>
        </Dialog>
      </Dialog.Root>
    </article>
  )
}
