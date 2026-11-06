import { describe, expect, it } from 'vitest'
import type { SupportedResource } from '@gadgets/workshop-shared/gatekeeper'
import { findBlueprintResource } from './blueprintResources'

const dev = 'https://dev.os.plxs.ai'
const prod = 'https://os.plxs.ai'
const resource = (urlPattern: string): SupportedResource => ({ urlPattern, title: 'Resource', description: 'Read access' })
const collectionPath = '/gatekeeper/cipp/accounts/:accountId/tenant-collections/:grantId'

describe('blueprint resource type discovery', () => {
  it.each([
    '/gatekeeper/cipp/accounts/:accountId/tenants',
    '/gatekeeper/cipp/accounts/:accountId/tenants/:tenantId',
    collectionPath,
  ])('offers the destination CIPP resource for %s imported from Dev', path => {
    const local = resource(prod + path)
    expect(findBlueprintResource('cipp', dev + path, [local], prod)).toBe(local)
  })

  it('prefers an exact match and preserves external resource identity', () => {
    const exact = resource('https://api.example.com/projects/:projectId')
    const local = resource(prod + collectionPath)
    expect(findBlueprintResource('example', exact.urlPattern, [local, exact], prod)).toBe(exact)
    expect(findBlueprintResource('cipp', dev + collectionPath, [local, resource(dev + collectionPath)], prod)?.urlPattern)
      .toBe(dev + collectionPath)
    expect(findBlueprintResource('example', exact.urlPattern, [resource('https://other.example.com/projects/:projectId')], prod))
      .toBeUndefined()
  })

  it.each([
    { vendor: 'other', source: dev + collectionPath, candidate: prod + collectionPath },
    { vendor: 'cipp', source: dev + collectionPath, candidate: prod + '/gatekeeper/other/accounts/:accountId/tenant-collections/:grantId' },
    { vendor: 'cipp', source: dev + collectionPath, candidate: prod + '/gatekeeper/cipp/accounts/:accountId/tenants/:tenantId' },
    { vendor: 'cipp', source: dev + collectionPath, candidate: prod + collectionPath + '/extra' },
    { vendor: 'cipp', source: dev + collectionPath + '?scope=all', candidate: prod + collectionPath },
    { vendor: 'cipp', source: dev + collectionPath + '?', candidate: prod + collectionPath },
    { vendor: 'cipp', source: dev + collectionPath, candidate: prod + collectionPath + '?scope=all' },
    { vendor: 'cipp', source: dev + collectionPath + '#fragment', candidate: prod + collectionPath },
    { vendor: 'cipp', source: dev + collectionPath, candidate: prod + collectionPath + '#' },
    { vendor: 'cipp', source: 'http://dev.os.plxs.ai' + collectionPath, candidate: prod + collectionPath },
    { vendor: 'cipp', source: dev + collectionPath, candidate: 'http://os.plxs.ai' + collectionPath },
    { vendor: 'cipp', source: dev + collectionPath, candidate: 'https://foreign.example.com' + collectionPath },
    { vendor: 'cipp', source: 'https://user:password@dev.os.plxs.ai' + collectionPath, candidate: prod + collectionPath },
    { vendor: 'cipp', source: 'https://*.example.com' + collectionPath, candidate: prod + collectionPath },
    { vendor: 'cipp', source: 'https://:host.example.com' + collectionPath, candidate: prod + collectionPath },
    { vendor: 'cipp', source: 'https://(dev|prod).example.com' + collectionPath, candidate: prod + collectionPath },
    { vendor: 'cipp', source: 'https://DEV.os.plxs.ai' + collectionPath, candidate: prod + collectionPath },
    { vendor: 'cipp', source: 'https://dev.os.plxs.ai:443' + collectionPath, candidate: prod + collectionPath },
    { vendor: 'cipp', source: dev + '/gatekeeper/cipp/temporary/../accounts/:accountId/tenant-collections/:grantId', candidate: prod + collectionPath },
    { vendor: 'cipp', source: dev + '/gatekeeper/cipp/%2e/accounts/:accountId/tenant-collections/:grantId', candidate: prod + collectionPath },
    { vendor: 'cipp', source: dev + '/gatekeeper/cippish/accounts/:accountId/tenant-collections/:grantId', candidate: prod + collectionPath },
  ])('rejects unsafe or incompatible remapping for $source', ({ vendor, source, candidate }) => {
    expect(findBlueprintResource(vendor, source, [resource(candidate)], prod)).toBeUndefined()
  })

  it('rejects ambiguous local candidates', () => {
    expect(findBlueprintResource('cipp', dev + collectionPath,
      [resource(prod + collectionPath), resource(prod + collectionPath)], prod)).toBeUndefined()
  })

  it('does not modify the source pattern, offered descriptors, or list', () => {
    const source = dev + collectionPath
    const offered = [resource(prod + collectionPath)]
    const before = structuredClone(offered)
    expect(findBlueprintResource('cipp', source, offered, prod)).toBe(offered[0])
    expect(offered).toEqual(before)
  })
})
