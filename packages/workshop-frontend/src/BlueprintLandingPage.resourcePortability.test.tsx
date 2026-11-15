// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://os.prod.example"}
/* eslint-disable react/react-in-jsx-scope */

import { act, useEffect, type ComponentProps, type ReactElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BlueprintPublicInfo, ConnectedAccountsSubscriber } from '@gadgets/workshop-shared/api'
import type { SupportedResource } from '@gadgets/workshop-shared/gatekeeper'
import type ResourceConfiguratorHost from './ResourceConfiguratorHost'

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = testGlobal.IS_REACT_ACT_ENVIRONMENT
testGlobal.IS_REACT_ACT_ENVIRONMENT = true
afterAll(() => {
  if (previousActEnvironment === undefined) delete testGlobal.IS_REACT_ACT_ENVIRONMENT
  else testGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})

const DEV_PATTERN = 'https://os.dev.example/gatekeeper/cipp/accounts/:accountId/tenant-collections/:grantId'
const PROD_PATTERN = 'https://os.prod.example/gatekeeper/cipp/accounts/:accountId/tenant-collections/:grantId'
const DEV_RESOURCE = 'https://os.dev.example/gatekeeper/cipp/accounts/dev-account/tenant-collections/dev-grant'
const PROD_RESOURCE = 'https://os.prod.example/gatekeeper/cipp/accounts/prod-account/tenant-collections/fresh-prod-grant'
const PROD_ACCOUNT_ID = 23
const vendor = { displayName: 'CIPP', url: 'https://cipp.example' }
const resource: SupportedResource = { urlPattern: PROD_PATTERN, title: 'CIPP customers', description: 'Selected customer tenants' }

const mocks = vi.hoisted(() => ({
  getBlueprint: vi.fn<(id: string) => Promise<BlueprintPublicInfo>>(),
  listGatekeeperVendors: vi.fn<() => Promise<unknown>>(),
  subscribeConnectedAccounts: vi.fn<(subscriber: ConnectedAccountsSubscriber) => unknown>(),
  startResourceConfigurator: vi.fn<(accountId: number, urlPattern: string) => Promise<unknown>>(),
  collect: vi.fn<() => Promise<string>>(),
  disposeFrame: vi.fn<() => void>(),
  disposeSubscription: vi.fn<() => void>(),
  authenticatedApi: {
    listModels: async () => [],
    getAdminApi: async () => null,
    isBlueprintInLibrary: async () => null,
    isBlueprintPinned: async () => false,
    getOwnBlueprint: async () => null,
  },
}))

vi.mock('@tanstack/react-router', () => ({
  useParams: () => ({ id: 'sms-report' }),
  useNavigate: () => () => {},
  useRouter: () => ({ history: { canGoBack: () => false } }),
}))
vi.mock('./useAuth', () => {
  const authenticatedApi = {
    ...mocks.authenticatedApi,
    listGatekeeperVendors: mocks.listGatekeeperVendors,
    subscribeConnectedAccounts: mocks.subscribeConnectedAccounts,
    startResourceConfigurator: mocks.startResourceConfigurator,
  }
  return { useAuth: () => ({ isAuthenticated: true, isLoading: false, authenticatedApi }) }
})
vi.mock('./useDocumentTitle', () => ({ useDocumentTitle: () => {} }))
vi.mock('./useDialogSelectPortalContainer', () => ({ useDialogSelectPortalContainer: () => null }))
vi.mock('./LoginPage', () => ({ default: () => null }))
vi.mock('./gatekeeper-modal/AccountChooser', () => ({
  AccountChooser: ({ selectedAccountId }: { selectedAccountId: number | null }) => <div>Account {selectedAccountId}</div>,
}))
vi.mock('./ResourceConfiguratorHost', () => ({
  default: ({ frame, onCollectResourceUrlChange, onSelectionReadyChange }: ComponentProps<typeof ResourceConfiguratorHost>) => {
    useEffect(() => {
      if (!frame) return
      onCollectResourceUrlChange?.(mocks.collect)
      onSelectionReadyChange?.(true)
      return () => {
        onCollectResourceUrlChange?.(null)
        onSelectionReadyChange?.(false)
      }
    }, [frame, onCollectResourceUrlChange, onSelectionReadyChange])
    return frame ? <div>Customer tenant configurator</div> : null
  },
}))
vi.mock('./components/WorkshopControls', () => ({
  WorkshopButton: ({ children, tone: _tone, ...props }: ComponentProps<'button'> & { tone?: string }) => <button type="button" {...props}>{children}</button>,
  WorkshopIconButton: ({ children, ...props }: ComponentProps<'button'>) => <button type="button" {...props}>{children}</button>,
}))
vi.mock('@cloudflare/kumo', () => {
  const Wrapper = ({ children }: { children?: ReactNode }) => <div>{children}</div>
  const Dialog = Object.assign(Wrapper, {
    Root: ({ open, children }: { open?: boolean; children?: ReactNode }) => open ? <dialog open>{children}</dialog> : null,
    Title: Wrapper,
    Description: Wrapper,
    Close: () => null,
  })
  const DropdownMenu = Object.assign(Wrapper, {
    Trigger: ({ render }: { render: ReactElement }) => render,
    Content: () => null,
    Item: () => null,
    Separator: () => null,
  })
  return { Dialog, DropdownMenu, Select: () => null, Button: Wrapper, Tooltip: Wrapper, useKumoToastManager: () => ({ add: () => {} }) }
})

import BlueprintLandingPage from './BlueprintLandingPage'

const publicApi = { getBlueprint: mocks.getBlueprint }
let container: HTMLDivElement
let root: Root

const blueprint = (typeUrlPattern: string): BlueprintPublicInfo => ({
  id: 'sms-report',
  metadata: {
    title: 'SMS MFA report', description: 'Exported from dev', version: 1,
    author: { type: 'user', id: 'author', name: 'Author' },
    created: new Date('2026-11-01'), lastUpdated: new Date('2026-11-01'),
    bindings: { CIPP_CUSTOMERS: { type: 'gatekeeper', gatekeeperName: 'cipp', title: 'CIPP customers', description: 'Read selected customer tenants',
      typeUrlPattern, resourceUrl: DEV_RESOURCE } },
  },
})

const button = (label: string) => {
  const found = [...container.querySelectorAll('button')].find(candidate => candidate.textContent === label)
  if (!found) throw new Error(`No "${label}" button in: ${container.textContent}`)
  return found
}
const click = async (label: string) => { await act(async () => { button(label).click() }) }
const openPage = async (pattern = DEV_PATTERN) => {
  mocks.getBlueprint.mockResolvedValue(blueprint(pattern))
  await act(async () => { root.render(<BlueprintLandingPage rpcStub={publicApi as never} />) })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.listGatekeeperVendors.mockResolvedValue([{ id: 'cipp', description: vendor, supportedResources: [resource] }])
  mocks.subscribeConnectedAccounts.mockImplementation((subscriber: ConnectedAccountsSubscriber) => {
    subscriber.add(PROD_ACCOUNT_ID, { displayName: 'Production CIPP', avatar: { url: 'https://cipp.example/logo.svg' } }, vendor, [resource], true, 'cipp')
    return Object.assign(Promise.resolve(), { [Symbol.dispose]: mocks.disposeSubscription })
  })
  mocks.startResourceConfigurator.mockResolvedValue({ iframeHtml: '<html></html>', ui: { [Symbol.dispose]: mocks.disposeFrame } })
  mocks.collect.mockResolvedValue(PROD_RESOURCE)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('Blueprint resource portability through the configure dialog', () => {
  it('requires a fresh production grant instead of automatically using the exported dev grant', async () => {
    expect(window.location.origin).toBe('https://os.prod.example')
    await openPage()
    expect(button('Configure 1 remaining connection')).toBeTruthy()
    expect(container.textContent).toContain('0 of 1 ready')
    expect(mocks.startResourceConfigurator).not.toHaveBeenCalled()

    await click('Configure 1 remaining connection')

    expect(mocks.startResourceConfigurator).toHaveBeenCalledExactlyOnceWith(PROD_ACCOUNT_ID, PROD_PATTERN)
    expect(container.textContent).toContain('Customer tenant configurator')
    expect(button('Save connection').disabled).toBe(false)
    await click('Save connection')

    expect(mocks.collect).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain('Everything is ready')
    expect(container.textContent).toContain(`Using: ${PROD_RESOURCE}`)
    expect(container.textContent).not.toContain(DEV_RESOURCE)
    expect(button('Create Gadget')).toBeTruthy()
  })

  it('keeps an unsupported external-host resource unconfigured without starting a frame', async () => {
    await openPage('https://external.example/api/accounts/:accountId/tenant-collections/:grantId')
    await click('Configure 1 remaining connection')

    expect(container.textContent).toContain("The required resource type for this binding isn't offered by CIPP.")
    expect(button('Save connection').disabled).toBe(true)
    expect(mocks.startResourceConfigurator).not.toHaveBeenCalled()
    expect(mocks.collect).not.toHaveBeenCalled()
    expect(container.textContent).toContain('0 of 1 ready')
  })
})
