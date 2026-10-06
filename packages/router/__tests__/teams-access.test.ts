import { describe, expect, it, vi } from 'vitest';
import { handleTeamsAccessRequest } from '../src/teams-access';
import router from '../src/index';

const env = { TEAMS_ACCESS_TAB_ENABLED: 'true', CF_ACCESS_ISS: 'https://example.cloudflareaccess.com', CF_ACCESS_AUD: 'dev-audience' };

describe('Teams Access entrypoint', () => {
  it('serves only a static landing page before sign-in, with no backend request', async () => {
    const backend = { fetch: vi.fn<Fetcher['fetch']>(async () => new Response('private')) };
    const response = await router.fetch!(new Request('https://example.test/teams/sign-in'),
      { ...env, WORKSHOP_BACKEND: backend }, {} as ExecutionContext);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Sign in');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Content-Security-Policy')).toContain("script-src 'self'");
    expect(response.headers.has('X-Frame-Options')).toBe(false);
    expect(backend.fetch).not.toHaveBeenCalled();
  });

  it('requires opt-in and refuses unknown public subtree routes, writes, and SPA fallback scripts', async () => {
    expect(await handleTeamsAccessRequest(new Request('https://example.test/teams/sign-in'), {})).toBeNull();
    expect((await handleTeamsAccessRequest(new Request('https://example.test/teams/sign-in/private'), env))?.status).toBe(404);
    expect((await handleTeamsAccessRequest(new Request('https://example.test/teams/sign-in', { method: 'POST' }), env))?.status).toBe(405);
    const ASSETS = { fetch: async () => new Response('<html>SPA</html>', { headers: { 'Content-Type': 'text/html' } }) };
    expect((await handleTeamsAccessRequest(new Request('https://example.test/teams/sign-in/bootstrap.js'), { ...env, ASSETS }))?.status).toBe(503);
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
