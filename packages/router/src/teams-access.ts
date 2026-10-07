import { verifyCfAccessJwt, type CfAccessEnv } from '../../workshop-backend/src/access';

const ENTRY_PATH = '/teams/sign-in';
const SCRIPT_PATH = '/teams/sign-in/bootstrap.js';
const CALLBACK_PATH = '/teams/auth-complete';
const FRAME_ANCESTORS = 'https://teams.microsoft.com https://*.teams.microsoft.com https://*.cloud.microsoft';

function page(bootstrap: string): Response {
  const nonce = crypto.randomUUID().replaceAll('-', '');
  // Keep the trusted bundle in this document: desktop authentication windows may
  // fail a separate script request after the cross-origin Access redirects.
  const script = bootstrap.replace(/<\/script/gi, '<\\/script');
  return new Response(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in to Plexus OS</title><style nonce="${nonce}">
:root { color-scheme: light dark; font-family: system-ui, sans-serif; background: Canvas; color: CanvasText; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; }
main { max-width: 32rem; padding: 2rem; } h1 { font-size: 1.75rem; } p { line-height: 1.5; }
button { font: inherit; padding: .6rem 1.2rem; cursor: pointer; } button:disabled { cursor: wait; }
a { color: LinkText; } :focus-visible { outline: 2px solid Highlight; outline-offset: 4px; }
</style></head>
<body><main><h1>Plexus OS</h1><p id="teams-access-status" role="status" aria-live="polite">Connecting to Microsoft Teams…</p>
<button id="teams-access-sign-in" type="button" disabled>Sign in</button>
<p><a id="teams-access-browser" href="/workspaces" target="_blank" rel="noopener noreferrer">Open in browser</a></p>
</main><script nonce="${nonce}">${script}</script></body></html>`, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors ${FRAME_ANCESTORS}`,
    },
  });
}

/** Public static sign-in UI; callback and session probes require verified Access claims. */
export async function handleTeamsAccessRequest(
  request: Request,
  env: CfAccessEnv & { TEAMS_ACCESS_TAB_ENABLED?: string; ASSETS?: Fetcher },
  verify: typeof verifyCfAccessJwt = verifyCfAccessJwt,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (env.TEAMS_ACCESS_TAB_ENABLED !== 'true') return null;
  if (!url.pathname.startsWith(`${ENTRY_PATH}/`) &&
      ![ENTRY_PATH, CALLBACK_PATH].includes(url.pathname)) return null;
  if (![ENTRY_PATH, SCRIPT_PATH, CALLBACK_PATH].includes(url.pathname)) {
    return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' } });
  }
  if (url.pathname === SCRIPT_PATH) return readBootstrap(request, env.ASSETS);
  if (url.pathname === CALLBACK_PATH) {
    const claims = await verify(request, env);
    if (typeof claims?.email !== 'string' || !claims.email) {
      return new Response('Sign-in required', { status: 401, headers: { 'Cache-Control': 'no-store' } });
    }
    if (url.searchParams.get('probe') === '1') {
      const probe = Response.json({ ready: true }, { headers: { 'Cache-Control': 'no-store' } });
      return request.method === 'HEAD' ? new Response(null, probe) : probe;
    }
  }
  const asset = await readBootstrap(new Request(new URL(SCRIPT_PATH, url)), env.ASSETS);
  if (!asset.ok) return asset;
  const response = page(await asset.text());
  return request.method === 'HEAD' ? new Response(null, response) : response;
}

async function readBootstrap(request: Request, assets?: Fetcher): Promise<Response> {
  if (!assets) return new Response('Sign-in assets unavailable', { status: 503 });
  const response = await assets.fetch(request);
  // A missing build must not turn a SPA fallback into executable JavaScript.
  if (!response.ok || !/^(?:application|text)\/javascript\b/.test(response.headers.get('Content-Type') ?? '')) {
    return new Response('Sign-in assets unavailable', { status: 503 });
  }
  return response;
}
