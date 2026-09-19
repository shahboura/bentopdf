/**
 * Cloudflare Worker entry for the BentoPDF fork deployment.
 *
 * Static assets are served directly by Workers Static Assets. This script only
 * runs for /libreoffice-wasm/* (configured via `run_worker_first` in
 * wrangler.toml) and streams those files from the private `bentopdf-assets` R2
 * bucket, because two of them exceed the 25 MiB per-asset limit.
 *
 * The BentoPDF loader requests them at `BASE_URL + 'libreoffice-wasm/'`
 * (same-origin), and the `.gz` files are streamed untouched (no
 * `Content-Encoding`) because the loader sniffs the gzip magic bytes and
 * decompresses them itself.
 */

const PATH_PREFIX = '/libreoffice-wasm/';
const BUCKET_PREFIX = 'libreoffice-wasm/';

const ALLOWED_FILES = new Set([
  'browser.worker.global.js',
  'soffice.js',
  'soffice.wasm.gz',
  'soffice.data.gz',
  'soffice.worker.js',
]);

function contentTypeFor(name) {
  if (name.endsWith('.gz')) return 'application/gzip';
  if (name.endsWith('.js')) return 'application/javascript; charset=utf-8';
  return 'application/octet-stream';
}

async function serveLibreOfficeAsset(request, env, name) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method Not Allowed', {
      status: 405,
      headers: { Allow: 'GET, HEAD' },
    });
  }

  const bucket = env.LIBREOFFICE_BUCKET;
  if (!bucket) {
    return new Response('LIBREOFFICE_BUCKET binding is not configured', {
      status: 500,
      headers: { 'Cache-Control': 'no-store' },
    });
  }

  if (!name || name.includes('..') || !ALLOWED_FILES.has(name)) {
    return new Response('Not Found', { status: 404 });
  }

  const key = `${BUCKET_PREFIX}${name}`;
  const isHead = request.method === 'HEAD';
  const object = isHead ? await bucket.head(key) : await bucket.get(key);
  if (object === null) {
    return new Response('Not Found', { status: 404 });
  }

  if (request.headers.get('if-none-match') === object.httpEtag) {
    return new Response(null, {
      status: 304,
      headers: {
        etag: object.httpEtag,
        'Cache-Control': 'public, max-age=3600',
        'Cross-Origin-Embedder-Policy': 'credentialless',
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Resource-Policy': 'cross-origin',
      },
    });
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('Content-Type', contentTypeFor(name));
  headers.set('Cache-Control', 'public, max-age=3600');
  headers.set('X-Content-Type-Options', 'nosniff');
  // Cloudflare does not apply `_headers` to Worker responses, so mirror the
  // document's cross-origin isolation headers here (upstream nginx applies these
  // to every location, including /libreoffice-wasm/). Without COEP on the
  // response, Chromium blocks the converter's worker script with
  // ERR_BLOCKED_BY_RESPONSE (blockedReason=coep-frame-resource-needs-coep-header).
  headers.set('Cross-Origin-Embedder-Policy', 'credentialless');
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
  // Serve the raw bytes; the client handles gzip decompression.
  headers.delete('Content-Encoding');

  if (isHead) {
    headers.set('Content-Length', String(object.size));
    return new Response(null, { status: 200, headers });
  }

  return new Response(object.body, { status: 200, headers });
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    if (pathname.startsWith(PATH_PREFIX)) {
      let name;
      try {
        name = decodeURIComponent(pathname.slice(PATH_PREFIX.length));
      } catch {
        return new Response('Bad Request', { status: 400 });
      }
      return serveLibreOfficeAsset(request, env, name);
    }

    // Safety fallback; run_worker_first keeps this from running for normal pages.
    return env.ASSETS.fetch(request);
  },
};
