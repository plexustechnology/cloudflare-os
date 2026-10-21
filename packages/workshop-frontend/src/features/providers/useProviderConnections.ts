import { useEffect, useRef, useState } from 'react'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi } from '@gadgets/workshop-shared/api'
import type { ProviderConnectionsApi } from '@gadgets/workshop-shared/provider-connections-api'
import type { ProviderConnectionDescriptor } from '@gadgets/workshop-shared/provider-connections'
import { providerErrorMessage } from './providerConnectionFlow'

type ConnectionSource = Pick<RpcStub<AuthenticatedApi>, 'getProviderConnectionsApi'>

/** Own and dispose the authenticated connection capability; stale sessions never retain it. */
export const useProviderConnections = (authenticatedApi: ConnectionSource) => {
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<{
    source: ConnectionSource
    api?: RpcStub<ProviderConnectionsApi>
    connections: ProviderConnectionDescriptor[]
    loading: boolean
    error?: string
  }>({ source: authenticatedApi, connections: [], loading: true })
  const epoch = useRef(0)
  const activeSource = useRef<ConnectionSource | null>(null)
  useEffect(() => {
    activeSource.current = authenticatedApi
    const operation = ++epoch.current
    let api: RpcStub<ProviderConnectionsApi> | undefined
    setState({ source: authenticatedApi, connections: [], loading: true })
    void (async () => {
      try {
        const obtained = await authenticatedApi.getProviderConnectionsApi()
        if (operation !== epoch.current) { obtained?.[Symbol.dispose](); return }
        if (!obtained) { setState({ source: authenticatedApi, connections: [], loading: false }); return }
        api = obtained
        setState({ source: authenticatedApi, api, connections: [], loading: true })
        const connections = await api.list()
        if (operation === epoch.current) setState({ source: authenticatedApi, api, connections, loading: false })
      } catch (error) {
        if (operation === epoch.current) setState({ source: authenticatedApi, api, connections: [], loading: false, error: providerErrorMessage(error) })
      }
    })()
    return () => { activeSource.current = null; ++epoch.current; api?.[Symbol.dispose]() }
  }, [authenticatedApi, attempt])
  const refresh = async () => {
    if (activeSource.current !== authenticatedApi || state.source !== authenticatedApi || !state.api) return
    const operation = ++epoch.current
    try {
      const connections = await state.api.list()
      if (operation === epoch.current) setState(previous => ({ ...previous, connections, error: undefined }))
    } catch (error) {
      if (operation === epoch.current) setState(previous => ({ ...previous, error: providerErrorMessage(error) }))
    }
  }
  return { ...(state.source === authenticatedApi ? state : { api: undefined, error: undefined, connections: [], loading: true }), refresh,
    retry: () => setAttempt(value => value + 1) }
}
