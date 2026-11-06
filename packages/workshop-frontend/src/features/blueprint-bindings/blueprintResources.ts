import type { SupportedResource } from '@gadgets/workshop-shared/gatekeeper'

const localGatekeeperPattern = (vendorId: string, pattern: string) => {
  if (!/^[a-z0-9_-]+$/i.test(vendorId)) return undefined
  const literal = /^(https:\/\/[^/?#]+)(\/[^?#]*)$/.exec(pattern)
  if (!literal) return undefined

  let url: URL
  try { url = new URL(pattern) } catch { return undefined }
  if (url.origin !== literal[1] || url.href !== pattern || url.username || url.password ||
      url.search || url.hash || !/^(?:[a-z0-9.-]+|\[[a-f0-9:]+\])$/.test(url.hostname) ||
      !url.pathname.startsWith(`/gatekeeper/${vendorId}/`)) return undefined

  return { origin: url.origin, path: url.pathname }
}

/** Resolve a blueprint's resource type to a locally offered type; never reuse its resource URL. */
export const findBlueprintResource = (
  vendorId: string,
  typeUrlPattern: string,
  resources: SupportedResource[],
  workshopOrigin: string,
): SupportedResource | undefined => {
  const exact = resources.find(resource => resource.urlPattern === typeUrlPattern)
  if (exact) return exact

  const source = localGatekeeperPattern(vendorId, typeUrlPattern)
  if (!source) return undefined

  // Only Workshop-hosted vendor routes may change origin. External API origins are
  // part of their resource identity, and the destination must still issue a fresh grant.
  const candidates = resources.filter(resource => {
    const local = localGatekeeperPattern(vendorId, resource.urlPattern)
    return local?.origin === workshopOrigin && local.path === source.path
  })
  return candidates.length === 1 ? candidates[0] : undefined
}
