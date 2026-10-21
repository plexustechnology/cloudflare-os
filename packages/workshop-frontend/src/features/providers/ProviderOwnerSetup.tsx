import { useEffect, useRef, useState } from 'react'
import { Button } from '@cloudflare/kumo'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi } from '@gadgets/workshop-shared/api'

type Source = Pick<RpcStub<AuthenticatedApi>, 'getProviderConnectionOwnerId'>

/** Expose only the current account's non-secret setup ID, even while the adapter is disabled. */
export const ProviderOwnerSetup = ({ authenticatedApi }: { authenticatedApi: Source }) => {
  const active = useRef<Source | null>(authenticatedApi)
  const [state, setState] = useState<{ source: Source; id?: string; loading?: boolean; failed?: boolean }>()
  useEffect(() => {
    active.current = authenticatedApi
    return () => { active.current = null }
  }, [authenticatedApi])
  const current = state?.source === authenticatedApi ? state : undefined
  const showId = async () => {
    const source = authenticatedApi
    setState({ source, loading: true })
    try {
      const id = await source.getProviderConnectionOwnerId()
      if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid setup ID')
      if (active.current === source) setState({ source, id })
    } catch {
      if (active.current === source) setState({ source, failed: true })
    }
  }
  return <details className="mx-3 mb-4 rounded-lg border border-kumo-line p-4">
    <summary className="cursor-pointer text-sm text-kumo-subtle">Provider deployment setup</summary>
    <p className="my-3 text-sm text-kumo-subtle">Your deployment operator can use your account ID to configure personal provider access. Sharing this ID does not grant access to your account.</p>
    <Button variant="secondary" className="min-h-11" disabled={current?.loading} onClick={() => void showId()}>
      {current?.loading ? 'Loading account ID…' : 'Show my provider owner ID'}
    </Button>
    {current?.id && <p className="mt-3 break-all font-mono text-sm text-kumo-default" aria-label="Provider owner ID"><code className="select-all">{current.id}</code></p>}
    {current?.failed && <p role="alert" className="mt-3 text-sm text-kumo-danger">Unable to obtain your account ID. Refresh and try again.</p>}
  </details>
}
