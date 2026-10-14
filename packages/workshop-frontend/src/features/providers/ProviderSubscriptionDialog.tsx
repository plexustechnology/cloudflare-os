import { useEffect, useRef, useState } from 'react'
import { Button, Checkbox, Dialog, Input } from '@cloudflare/kumo'
import type { RpcStub } from 'capnweb'
import type { ProviderSubscriptionConnectionsApi, ProviderSubscriptionHandoff } from '@gadgets/workshop-shared/provider-connections-api'
import type { ProviderSubscriptionDescriptor } from '@gadgets/workshop-shared/provider-connections'
import { startSubscriptionConnection, subscriptionHelperCommand, subscriptionManualLink } from './subscriptionConnectionFlow'

type Props = { api: RpcStub<ProviderSubscriptionConnectionsApi>; connection?: ProviderSubscriptionDescriptor; onClose: () => void; onChanged: () => Promise<void> }
/** Owner consent and paired local handoff; transient fields never enter browser storage. */
export const ProviderSubscriptionDialog = ({ api, connection, onClose, onChanged }: Props) => {
  const origin = location.origin
  const [label, setLabel] = useState(connection?.label ?? '')
  const [port, setPort] = useState('')
  const [pairing, setPairing] = useState('')
  const [ownerConsent, setOwnerConsent] = useState(false)
  const [outputConsent, setOutputConsent] = useState(false)
  const [usageConsent, setUsageConsent] = useState(false)
  const [compaction, setCompaction] = useState(false)
  const [ready, setReady] = useState<{ handoff: ProviderSubscriptionHandoff; automatic: boolean }>()
  const [manual, setManual] = useState('')
  const [phase, setPhase] = useState('setup')
  const [message, setMessage] = useState('')
  const active = useRef(true)
  const operation = useRef<ReturnType<typeof startSubscriptionConnection> | undefined>(undefined)
  useEffect(() => {
    active.current = true
    return () => { active.current = false; void operation.current?.cancel() }
  }, [])
  const close = () => { setPairing(''); setManual(''); void operation.current?.cancel(); onClose() }
  const start = async () => {
    if (operation.current) return
    const selectedPort = Number(port)
    if (!label.trim() || label.trim().length > 80 || [...label].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) || !/^[0-9]{4,5}$/.test(port) || selectedPort < 1024 || selectedPort > 65535 ||
        !/^[A-Za-z0-9_-]{43}$/.test(pairing) || !ownerConsent || !outputConsent || !usageConsent) {
      setMessage('Enter a valid label, helper port and pairing nonce, and accept all three acknowledgments.'); return
    }
    setMessage(''); setPhase('checking')
    const flow = startSubscriptionConnection(api, { label: label.trim(), consent: { billing: 'chatgpt-plan', ownerInteractive: true,
      sessionCompaction: compaction, acceptsProviderControlledOutput: true, acceptsSharedPlanAndCreditUsage: true } }, connection, selectedPort, pairing, {
      onReady: (handoff, automatic) => { if (active.current) { setReady({ handoff, automatic }); setPhase('waiting') } },
      onCompleting: () => { if (active.current) { setManual(''); setReady(undefined); setPhase('completing') } },
    })
    operation.current = flow
    const outcome = await flow.completion
    if (!active.current || operation.current !== flow) return
    await onChanged().catch(() => undefined)
    if (!active.current || operation.current !== flow) return
    setPairing(''); setManual(''); setReady(undefined)
    if (outcome.kind === 'saved') {
      setPhase(outcome.connection.status === 'plan-disabled' ? 'plan-unavailable' : 'saved')
      setMessage(outcome.connection.status === 'plan-disabled' ? 'Authorization saved. ChatGPT plan access was not granted. Inference setup is pending.' : 'Authorization saved. Inference setup is pending.')
    } else if (outcome.kind === 'declined') {
      setPhase('declined'); setMessage(outcome.connection.credentialConfigured
        ? 'Sign-in declined. Your prior saved authorization remains. Inference setup is pending.'
        : 'Sign-in declined. No new authorization was saved.')
    } else if (outcome.kind === 'cancelled') {
      setPhase('cancelled'); setMessage(outcome.connection?.credentialConfigured && outcome.connection.generation > (connection?.generation ?? 1)
        ? 'Authorization completed before cancellation. Its saved grant remains; inspect status or disconnect it explicitly.' : 'This sign-in was cancelled. Any prior saved authorization remains.')
    } else { setPhase(outcome.message.includes('expired') ? 'expired' : 'unknown'); setMessage(outcome.message) }
  }
  const cancel = async () => {
    const current = await operation.current?.cancel()
    if (active.current && current?.credentialConfigured && current.generation > (connection?.generation ?? 1)) setMessage('Authorization completed before cancellation. Its saved grant remains; inspect status or disconnect it explicitly.')
  }
  const busy = ['checking', 'waiting', 'completing'].includes(phase)
  return <Dialog.Root open onOpenChange={open => { if (!open) close() }}>
    <Dialog className="responsive-dialog max-md:translate-y-0! [@media(max-height:520px)]:translate-y-0! max-h-[calc(var(--app-height)-32px)] overflow-y-auto overscroll-contain p-6" size="lg">
      <Dialog.Title className="text-lg font-semibold text-kumo-default">{connection ? 'Reconnect ChatGPT authorization' : 'Connect ChatGPT authorization'}</Dialog.Title>
      <p className="mt-3 text-sm text-kumo-subtle">Run the helper on this computer from your Plexus checkout using Node 24. It receives and encrypts the callback; Plexus privately stores authorization. Subscription inference setup is pending.</p>
      <pre className="mt-3 overflow-x-auto rounded-lg bg-kumo-tint p-3 text-sm text-kumo-default"><code>{subscriptionHelperCommand(origin)}</code></pre>
      <form className="mt-4 space-y-4" onSubmit={event => { event.preventDefault(); void start() }}>
        <Input label="Connection label" value={label} maxLength={80} disabled={phase !== 'setup'} onChange={event => setLabel(event.target.value)} className="min-h-11" />
        <Input label="Helper port" inputMode="numeric" value={port} maxLength={5} disabled={phase !== 'setup'} onChange={event => setPort(event.target.value)} className="min-h-11" />
        <Input label="Pairing nonce" type="password" autoComplete="off" value={pairing} maxLength={43} disabled={phase !== 'setup'} onChange={event => setPairing(event.target.value)} className="min-h-11" description="Use the nonce printed by this helper invocation." />
        <Checkbox disabled={phase !== 'setup'} checked={ownerConsent} onCheckedChange={v => setOwnerConsent(v === true)} label="Allow this ChatGPT authorization only for my own interactive chats." />
        <Checkbox disabled={phase !== 'setup'} checked={outputConsent} onCheckedChange={v => setOutputConsent(v === true)} label="I accept provider-controlled output and costs, including generation before Plexus may reject output above its acceptance limit." />
        <Checkbox disabled={phase !== 'setup'} checked={usageConsent} onCheckedChange={v => setUsageConsent(v === true)} label="I accept shared ChatGPT plan allowance and credit usage. This does not authorize purchases or top-ups." />
        <Checkbox disabled={phase !== 'setup'} checked={compaction} onCheckedChange={v => setCompaction(v === true)} label="Also allow context summaries within my own chat session." />
        {phase === 'setup' && <Button type="submit" className="min-h-11" variant="primary">Set up sign-in</Button>}
      </form>
      {ready && <div className="mt-4 space-y-3">
        {ready.automatic && <a className="inline-flex min-h-11 items-center rounded-lg border border-kumo-line px-4 text-kumo-link" href={ready.handoff.authorizationUrl} target="_blank" rel="noopener noreferrer">Continue with ChatGPT</a>}
        <p className="text-sm text-kumo-subtle">{ready.automatic ? 'The callback completes automatically. This ordinary link also works when popups are blocked.' : 'This browser restricted the local bridge. Use encrypted manual recovery below.'}</p>
        <details open={!ready.automatic}><summary className="min-h-11 cursor-pointer text-kumo-link">Encrypted manual recovery</summary>
          <p className="mt-2 text-sm text-kumo-subtle">Open the local helper, continue there, and copy only the encrypted callback. Return here and paste it once.</p>
          <a className="mt-2 inline-flex min-h-11 items-center text-kumo-link" href={subscriptionManualLink(origin, Number(port), pairing, ready.handoff)} target="_blank" rel="noopener noreferrer">Open local helper</a>
          <Input label="Encrypted callback" value={manual} maxLength={12000} autoComplete="off" onChange={event => setManual(event.target.value)} className="min-h-11" />
          <Button className="mt-3 min-h-11" variant="secondary" disabled={!manual} onClick={() => { const text = manual; setManual(''); operation.current?.submitManual(text) }}>Submit encrypted callback once</Button>
        </details>
      </div>}
      <p aria-live="polite" className="mt-4 text-sm text-kumo-subtle">{phase === 'checking' ? 'Checking helper and preparing authorization…' : phase === 'waiting' ? 'Waiting for sign-in…' : phase === 'completing' ? 'Completing authorization…' : ''}</p>
      {message && <p role={phase === 'saved' ? 'status' : 'alert'} className="mt-3 text-sm text-kumo-default">{message}</p>}
      <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:justify-end">
        {busy && <Button className="min-h-11" variant="secondary" onClick={() => void cancel()}>Cancel this sign-in</Button>}
        <Button className="min-h-11" variant="secondary" onClick={close}>{busy ? 'Close and cancel' : 'Close'}</Button>
      </div>
    </Dialog>
  </Dialog.Root>
}
