import { useState } from 'react'
import { Button } from '@cloudflare/kumo'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi } from '@gadgets/workshop-shared/api'
import type { ProviderSubscriptionConnectionsApi } from '@gadgets/workshop-shared/provider-connections-api'
import type { ProviderSubscriptionDescriptor } from '@gadgets/workshop-shared/provider-connections'
import { useProviderSubscriptions } from './useProviderSubscriptions'
import { ProviderSubscriptionDialog } from './ProviderSubscriptionDialog'
import { ProviderSubscriptionCard } from './ProviderSubscriptionCard'

/** Optional owner subscription management remains separate from API billing and model selection. */
export const ProviderSubscriptionsSection = ({ authenticatedApi }: { authenticatedApi: RpcStub<AuthenticatedApi> }) => {
  const { api, connections, loading, error, refresh, retry } = useProviderSubscriptions(authenticatedApi)
  const [dialog, setDialog] = useState<{ api: RpcStub<ProviderSubscriptionConnectionsApi>; connection?: ProviderSubscriptionDescriptor }>()
  if (!api && !error) return loading ? <p aria-live="polite" className="px-3 py-4 text-sm text-kumo-subtle">Checking ChatGPT authorization access…</p> : null
  return <section className="mx-3 mb-6 space-y-4" aria-labelledby="chatgpt-authorization-heading">
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div><h2 id="chatgpt-authorization-heading" className="text-lg font-semibold text-kumo-default">ChatGPT authorization</h2><p className="mt-1 text-sm text-kumo-subtle">Plan allowance and credits are separate from OpenAI API billing. Saved authorization does not confirm eligibility or inference readiness.</p></div>
      {api && <Button className="min-h-11 shrink-0" variant="primary" onClick={() => setDialog({ api })}>Connect ChatGPT</Button>}
    </div>
    {error && <div><p role="alert" className="text-sm text-kumo-danger">{error}</p><Button className="mt-3 min-h-11" variant="secondary" onClick={api ? () => void refresh() : retry}>Refresh status</Button></div>}
    {api && connections.map(connection => <ProviderSubscriptionCard key={`${connection.connectionId}:${connection.generation}:${connection.credentialRevision}:${connection.status}:${connection.pendingAuthorization?.attemptId ?? ''}`} api={api} connection={connection} onReconnect={() => setDialog({ api, connection })} onChanged={refresh} />)}
    {api && !loading && !connections.length && <p className="text-sm text-kumo-subtle">No ChatGPT authorizations yet.</p>}
    {api && <Button className="min-h-11" variant="secondary" onClick={() => void refresh()}>Refresh authorization status</Button>}
    {dialog && dialog.api === api && <ProviderSubscriptionDialog key={dialog.connection?.connectionId ?? 'new'} api={dialog.api} connection={dialog.connection} onClose={() => { setDialog(undefined); void refresh() }} onChanged={refresh} />}
  </section>
}
