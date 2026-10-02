import { Button, Loader } from '@cloudflare/kumo'
import { useEffect, useRef } from 'react'
import { useSiteName } from '../../ServerConfigContext'

/** An accessible wait state shared by host and ordinary-session checks. */
export const TeamsBootScreen = ({ message }: { message: string }) => (
  <main className="flex min-h-full items-center justify-center bg-kumo-base px-6 py-10">
    <div className="flex max-w-sm flex-col items-center text-center">
      <Loader size="lg" />
      <p aria-live="polite" className="mt-3 text-sm text-kumo-subtle" role="status">{message}</p>
    </div>
  </main>
)

/** Browser recovery preserves a validated destination without granting access to it. */
export const TeamsRecoveryPanel = ({
  browserUrl,
  message,
  onRetry,
}: {
  browserUrl: string
  message: string
  onRetry: () => void
}) => {
  const siteName = useSiteName()
  const ref = useRef<HTMLElement>(null)
  useEffect(() => ref.current?.focus(), [])
  return (
    <main className="flex min-h-full items-center justify-center bg-kumo-base px-6 py-10">
      <section ref={ref} tabIndex={-1} aria-labelledby="teams-recovery-title"
        className="w-full max-w-md rounded-xl border border-kumo-line bg-kumo-elevated p-6">
        <h1 id="teams-recovery-title" className="text-xl font-semibold text-kumo-default">
          Open {siteName} in your browser
        </h1>
        <p className="mt-2 text-sm leading-6 text-kumo-subtle" role="alert">{message}</p>
        <div className="mt-6 flex flex-wrap gap-3">
          <Button onClick={onRetry} variant="secondary">Retry in Teams</Button>
          <a href={browserUrl} target="_blank" rel="noopener noreferrer"
            className="inline-flex h-9 items-center justify-center rounded-lg border border-kumo-line px-3.5 text-sm font-medium text-kumo-default hover:bg-kumo-tint">
            Continue in browser
          </a>
        </div>
      </section>
    </main>
  )
}
