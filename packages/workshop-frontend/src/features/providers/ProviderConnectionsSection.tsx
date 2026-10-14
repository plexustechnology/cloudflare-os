import { useState } from 'react'
import { Button } from '@cloudflare/kumo'
import type { RpcStub } from 'capnweb'
import type { ProviderConnectionsApi } from '@gadgets/workshop-shared/provider-connections-api'
import type { AuthenticatedApi } from '@gadgets/workshop-shared/api'
import type { ProviderConnectionDescriptor } from '@gadgets/workshop-shared/provider-connections'
import { useProviderConnections } from './useProviderConnections'
import { ProviderCredentialDialog } from './ProviderCredentialDialog'
import { ProviderConnectionCard } from './ProviderConnectionCard'

type Props = { authenticatedApi: RpcStub<AuthenticatedApi>; onModelAdded: () => Promise<void> }

/** Compose eligible personal connection controls beside the existing provider list. */
export const ProviderConnectionsSection = ({ authenticatedApi, onModelAdded }: Props) => {
  const { api, connections, loading, error, retry, refresh } = useProviderConnections(authenticatedApi)
  const [dialog, setDialog] = useState<{ api: RpcStub<ProviderConnectionsApi>; connection?: ProviderConnectionDescriptor }>()
  if (!api) {
    if (error) return <div className="mx-3 my-4 rounded-lg border border-kumo-line p-4"><p role="alert" className="text-sm text-kumo-danger">Unable to load personal connections. Refresh to inspect your access.</p><Button variant="secondary" className="mt-3 min-h-11" onClick={retry}>Try again</Button></div>
    return loading ? <p aria-live="polite" className="px-3 py-4 text-sm text-kumo-subtle">Checking personal connection access…</p> : null
  }
  return <section aria-labelledby="personal-connections-heading" className="mx-3 mb-6 space-y-4">
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0"><h2 id="personal-connections-heading" className="text-lg font-semibold text-kumo-default">OpenAI API connections</h2><p className="mt-1 text-sm text-kumo-subtle">API costs are handled separately by OpenAI and are unknown locally. Cloudflare balances and usage describe Cloudflare funding.</p></div>
      <Button variant="primary" className="min-h-11 shrink-0" onClick={() => setDialog({ api })}>Connect OpenAI API</Button>
    </div>
    {loading && <p aria-live="polite" className="text-sm text-kumo-subtle">Loading connections…</p>}
    {error && <div><p role="alert" className="text-sm text-kumo-danger">{error}</p><Button variant="secondary" className="mt-3 min-h-11" onClick={() => void refresh()}>Refresh connections</Button></div>}
    {!loading && !error && connections.length === 0 && <p className="text-sm text-kumo-subtle">No personal connections yet.</p>}
    {connections.map(connection => <ProviderConnectionCard key={`${connection.connectionId}:${connection.generation}:${connection.credentialRevision}:${connection.status}`} api={api} connection={connection} onReconnect={() => setDialog({ api, connection })} onChanged={refresh} onModelAdded={onModelAdded} />)}
    <Button variant="secondary" className="min-h-11" onClick={() => void refresh()}>Refresh connections</Button>
    {dialog?.api === api && <ProviderCredentialDialog api={api} connection={dialog.connection} onClose={() => { setDialog(undefined); void refresh() }} onSettled={refresh} onSaved={() => { setDialog(undefined) }} />}
  </section>
}
