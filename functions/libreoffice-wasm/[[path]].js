/**
 * Cloudflare Pages Function that serves the LibreOffice WASM assets from the
 * private `bentopdf-assets` R2 bucket.
 *
 * Route: /libreoffice-wasm/*
 * Required Pages binding: LIBREOFFICE_BUCKET -> bentopdf-assets
 *
 * The BentoPDF loader (`src/js/utils/libreoffice-loader.ts`) requests these
 * files at `BASE_URL + 'libreoffice-wasm/'`, i.e. same-origin, so no CORS is
 * involved. The `.gz` files are streamed untouched (no `Content-Encoding`)
 * because the loader sniffs the gzip magic bytes and decompresses them itself.
 */

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

export async function onRequest(context) {
  const { request, env, params } = context;

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

  const segments = Array.isArray(params.path) ? params.path : [params.path];
  const name = segments.filter(Boolean).join('/');

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
      },
    });
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('Content-Type', contentTypeFor(name));
  headers.set('Cache-Control', 'public, max-age=3600');
  headers.set('X-Content-Type-Options', 'nosniff');
  // Serve the raw bytes; the client handles gzip decompression.
  headers.delete('Content-Encoding');

  if (isHead) {
    headers.set('Content-Length', String(object.size));
    return new Response(null, { status: 200, headers });
  }

  return new Response(object.body, { status: 200, headers });
}
