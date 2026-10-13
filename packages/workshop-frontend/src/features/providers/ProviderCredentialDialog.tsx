import { useEffect, useId, useRef, useState } from 'react'
import { Button, Checkbox, Dialog, Input } from '@cloudflare/kumo'
import type { RpcStub } from 'capnweb'
import type { ProviderConnectionsApi } from '@gadgets/workshop-shared/provider-connections-api'
import type { ProviderConnectionDescriptor } from '@gadgets/workshop-shared/provider-connections'
import { submitProviderCredential } from './providerConnectionFlow'

type Props = {
  api: RpcStub<ProviderConnectionsApi>
  connection?: ProviderConnectionDescriptor
  onClose: () => void
  onSaved: () => void
  onSettled: () => Promise<void>
}

/** Explicit API funding consent and write-only, transient credential intake. */
export const ProviderCredentialDialog = ({ api, connection, onClose, onSaved, onSettled }: Props) => {
  const id = useId()
  const [label, setLabel] = useState(connection?.label ?? '')
  const [key, setKey] = useState('')
  const [consent, setConsent] = useState(false)
  const [compaction, setCompaction] = useState(false)
  const [error, setError] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const active = useRef(true)
  const submission = useRef<ReturnType<typeof submitProviderCredential> | undefined>(undefined)
  useEffect(() => {
    active.current = true
    return () => { active.current = false; submission.current?.cancel() }
  }, [])
  const close = () => {
    setKey('')
    submission.current?.cancel()
    onClose()
  }
  const submit = async () => {
    if (busy || submission.current || error) return
    const submittedKey = key
    setKey('')
    const validation: Record<string, string> = {}
    if (!label.trim() || label.trim().length > 80 || [...label].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) validation.label = 'Enter a label of 1 to 80 characters.'
    if (!submittedKey || !/^[\x21-\x7e]{1,4096}$/.test(submittedKey)) validation.key = 'Enter a valid OpenAI API key.'
    if (!consent) validation.consent = 'Accept API billing for your own chats to continue.'
    setErrors(validation)
    if (Object.keys(validation).length) return
    const input = { label: label.trim(), apiKey: submittedKey, consent: {
      billing: 'openai-platform-api' as const, ownerInteractive: true as const, sessionCompaction: compaction,
    } }
    setKey('')
    setBusy(true)
    setError('')
    const operation = submitProviderCredential(api, input, connection)
    submission.current = operation
    const outcome = await operation.completion
    await onSettled()
    if (!active.current || submission.current !== operation) return
    submission.current = undefined
    setBusy(false)
    setKey('')
    if (outcome.kind === 'saved') onSaved()
    else if (outcome.kind === 'error') setError(outcome.message)
  }
  return (
    <Dialog.Root open onOpenChange={open => { if (!open) close() }}>
      {/* Reset Kumo Y centering explicitly: Tailwind drops the global mobile zero-translate declaration. */}
      <Dialog className="responsive-dialog max-md:translate-y-0! [@media(max-height:520px)]:translate-y-0! max-h-[calc(var(--app-height)-32px)] overflow-y-auto overscroll-contain p-6" size="lg">
        <Dialog.Title className="text-lg font-semibold text-kumo-default">
          {connection ? 'Reconnect OpenAI API' : 'Connect OpenAI API'}
        </Dialog.Title>
        <p className="mt-3 text-sm text-kumo-subtle">OpenAI API usage is billed separately by OpenAI. A ChatGPT subscription does not cover API costs. Costs and remaining API balance are unknown here.</p>
        <p className="mt-3 text-sm text-kumo-subtle">ChatGPT subscription access is unavailable in this deployment.</p>
        {connection && <p className="mt-3 rounded-lg bg-kumo-tint p-3 text-sm text-kumo-default">Replacing the key stops running work and requires choosing your model again. Cancellation disables this connection locally.</p>}
        <form className="mt-4 space-y-4" onSubmit={event => { event.preventDefault(); void submit() }}>
          <Input className="min-h-11" label="Connection label" value={label} maxLength={80} disabled={busy}
            onChange={event => setLabel(event.target.value)} error={errors.label} variant={errors.label ? 'error' : 'default'} />
          <Input className="min-h-11" label="OpenAI API key" type="password" value={key} autoComplete="off" maxLength={4096} disabled={busy}
            onChange={event => setKey(event.target.value)} error={errors.key} variant={errors.key ? 'error' : 'default'}
            description="Submitted once. The key cannot be read back." />
          <div className="min-h-11">
            <Checkbox checked={consent} disabled={busy} variant={errors.consent ? 'error' : 'default'}
              label="I accept OpenAI API billing for my own interactive chats. This connection cannot fund shared or scheduled work."
              ref={element => {
                // Kumo's Checkbox exposes a ref but no describedby/invalid props in this version.
                if (!element) return
                element.setAttribute('aria-invalid', String(!!errors.consent))
                if (errors.consent) element.setAttribute('aria-describedby', `${id}-consent-error`)
                else element.removeAttribute('aria-describedby')
              }}
              onCheckedChange={checked => setConsent(checked === true)} />
            {errors.consent && <p id={`${id}-consent-error`} className="mt-1 text-sm text-kumo-danger">{errors.consent}</p>}
          </div>
          <div className="min-h-11">
            <Checkbox checked={compaction} disabled={busy}
              label="Also allow paid context summaries within my own chat session."
              onCheckedChange={checked => setCompaction(checked === true)} />
          </div>
          <div aria-live="polite" className="text-sm text-kumo-subtle">
            {busy && 'Saving connection… You can cancel to disable it locally.'}
          </div>
          {error && <p role="alert" className="text-sm text-kumo-danger">{error} Close this dialog and refresh to inspect the outcome. Your key has been cleared.</p>}
          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <Button type="button" variant="secondary" className="min-h-11" onClick={close}>Cancel</Button>
            <Button type="submit" variant="primary" className="min-h-11" disabled={busy || !!error} loading={busy}>
              {connection ? 'Replace key' : 'Connect OpenAI API'}
            </Button>
          </div>
        </form>
      </Dialog>
    </Dialog.Root>
  )
}
