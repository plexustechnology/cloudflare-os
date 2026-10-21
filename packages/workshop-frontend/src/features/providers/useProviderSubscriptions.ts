import { useEffect, useRef, useState } from 'react'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi } from '@gadgets/workshop-shared/api'
import type { ProviderSubscriptionConnectionsApi } from '@gadgets/workshop-shared/provider-connections-api'
import type { ProviderSubscriptionDescriptor } from '@gadgets/workshop-shared/provider-connections'
import { subscriptionErrorMessage } from './subscriptionConnectionFlow'

type Source = Pick<RpcStub<AuthenticatedApi>, 'getProviderSubscriptionConnectionsApi'>
/** Own the optional subscription capability across authenticated source changes. */
export const useProviderSubscriptions = (source: Source) => {
  const [retryCount, setRetryCount] = useState(0)
  const [state, setState] = useState<{ source: Source; api?: RpcStub<ProviderSubscriptionConnectionsApi>; connections: ProviderSubscriptionDescriptor[]; loading: boolean; error?: string }>({ source, connections: [], loading: true })
  const epoch = useRef(0)
  const activeSource = useRef<Source | null>(null)
  const activeCapability = useRef<RpcStub<ProviderSubscriptionConnectionsApi> | undefined>(undefined)
  useEffect(() => {
    activeSource.current = source
    const operation = ++epoch.current
    let api: RpcStub<ProviderSubscriptionConnectionsApi> | undefined
    setState({ source, connections: [], loading: true })
    void (async () => {
      try {
        const obtained = await source.getProviderSubscriptionConnectionsApi()
        if (epoch.current !== operation) { obtained?.[Symbol.dispose](); return }
        if (!obtained) { setState({ source, connections: [], loading: false }); return }
        api = obtained
        activeCapability.current = obtained
        const connections = await api.list()
        if (epoch.current === operation) setState({ source, api, connections, loading: false })
      } catch (error) { if (epoch.current === operation) setState({ source, api, connections: [], loading: false, error: subscriptionErrorMessage(error) }) }
    })()
    return () => { activeSource.current = null; activeCapability.current = undefined; ++epoch.current; api?.[Symbol.dispose]() }
  }, [source, retryCount])
  const refresh = async () => {
    if (activeSource.current !== source || state.source !== source || !state.api || activeCapability.current !== state.api) return
    const operation = ++epoch.current
    try { const connections = await state.api.list(); if (operation === epoch.current && activeSource.current === source) setState(previous => ({ ...previous, connections, error: undefined })) }
    catch (error) { if (operation === epoch.current && activeSource.current === source) setState(previous => ({ ...previous, error: subscriptionErrorMessage(error) })) }
  }
  return { ...(state.source === source ? state : { connections: [], loading: true, api: undefined, error: undefined }), refresh, retry: () => setRetryCount(value => value + 1) }
}
