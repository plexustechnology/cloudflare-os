import { describe, expect, it, vi } from 'vitest';
import { handleTeamsAccessRequest } from '../src/teams-access';
import router from '../src/index';

const env = {
  TEAMS_ACCESS_TAB_ENABLED: 'true', CF_ACCESS_ISS: 'https://example.cloudflareaccess.com', CF_ACCESS_AUD: 'dev-audience',
  ASSETS: { fetch: async () => new Response('window.bootstrapLoaded = true;', { headers: { 'Content-Type': 'text/javascript' } }) },
};

describe('Teams Access entrypoint', () => {
  it('serves only a static landing page before sign-in, with no backend request', async () => {
    const backend = { fetch: vi.fn<Fetcher['fetch']>(async () => new Response('private')) };
    const response = await router.fetch!(new Request('https://example.test/teams/sign-in'),
      { ...env, WORKSHOP_BACKEND: backend }, {} as ExecutionContext);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('Sign in');
    expect(html).toContain('window.bootstrapLoaded = true;');
    expect(html).not.toContain('<script src=');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const nonce = html.match(/<script nonce="([a-f0-9]+)">/)?.[1];
    expect(nonce).toBeTruthy();
    expect(response.headers.get('Content-Security-Policy')).toContain(`script-src 'nonce-${nonce}'`);
    expect(response.headers.has('X-Frame-Options')).toBe(false);
    expect(backend.fetch).not.toHaveBeenCalled();
  });

  it('embeds the bootstrap after Access verification without forwarding user credentials to assets', async () => {
    const verify = vi.fn<NonNullable<Parameters<typeof handleTeamsAccessRequest>[2]>>(async () => ({ email: 'operator@example.test' }));
    const ASSETS = { fetch: vi.fn<Fetcher['fetch']>(async () => new Response('window.callbackLoaded = true;', {
      headers: { 'Content-Type': 'application/javascript' },
    })) };
    const response = await handleTeamsAccessRequest(new Request('https://example.test/teams/auth-complete?state=correlation', {
      headers: { Cookie: 'synthetic-cookie', 'cf-access-jwt-assertion': 'synthetic-assertion' },
    }), { ...env, ASSETS }, verify);
    expect(await response?.text()).toContain('window.callbackLoaded = true;');
    const assetRequest = ASSETS.fetch.mock.calls[0][0] as Request;
    expect(assetRequest.url).toBe('https://example.test/teams/sign-in/bootstrap.js');
    expect([...assetRequest.headers]).toEqual([]);
  });

  it('does not let a closing script tag in the bundle escape the nonce-authorized script', async () => {
    const ASSETS = { fetch: async () => new Response('window.example = "</script><script>untrusted()</script>";', {
      headers: { 'Content-Type': 'text/javascript' },
    }) };
    const response = await handleTeamsAccessRequest(new Request('https://example.test/teams/sign-in'), { ...env, ASSETS });
    const html = await response!.text();
    expect(html.match(/<script\b/g)).toHaveLength(2); // One trusted tag and the inert string literal.
    expect(html.match(/<\/script>/g)).toHaveLength(1);
    expect(html).toContain('<\\/script>');
  });

  it('requires opt-in and refuses unknown public subtree routes, writes, and SPA fallback scripts', async () => {
    expect(await handleTeamsAccessRequest(new Request('https://example.test/teams/sign-in'), {})).toBeNull();
    expect((await handleTeamsAccessRequest(new Request('https://example.test/teams/sign-in/private'), env))?.status).toBe(404);
    expect((await handleTeamsAccessRequest(new Request('https://example.test/teams/sign-in', { method: 'POST' }), env))?.status).toBe(405);
    const ASSETS = { fetch: async () => new Response('<html>SPA</html>', { headers: { 'Content-Type': 'text/html' } }) };
    expect((await handleTeamsAccessRequest(new Request('https://example.test/teams/sign-in/bootstrap.js'), { ...env, ASSETS }))?.status).toBe(503);
    expect((await handleTeamsAccessRequest(new Request('https://example.test/teams/sign-in'), { ...env, ASSETS }))?.status).toBe(503);
  });

  it('rejects a callback without a verified user assertion, including a forged assertion', async () => {
    const request = new Request('https://example.test/teams/auth-complete?probe=1');
    expect((await handleTeamsAccessRequest(request, env))?.status).toBe(401);
    const invalid = new Request(request, { headers: { 'cf-access-jwt-assertion': 'forged' } });
    expect((await handleTeamsAccessRequest(invalid, env))?.status).toBe(401);
  });

  it('returns no identity data from a verified callback probe', async () => {
    const verify = vi.fn<NonNullable<Parameters<typeof handleTeamsAccessRequest>[2]>>(async () => ({ email: 'operator@example.test' }));
    const request = new Request('https://example.test/teams/auth-complete?probe=1');
    const response = await handleTeamsAccessRequest(request, env, verify);
    expect(verify).toHaveBeenCalledWith(request, env);
    expect(await response?.json()).toEqual({ ready: true });
    expect(response?.headers.get('Cache-Control')).toBe('no-store');
  });
});
