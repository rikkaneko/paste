// Proxy URI (Accept *.js, *.css, *.html, *.ico only)
// Use ETag and If-None-Match to cache file
export async function serve_static(path: string, req_headers?: Headers): Promise<Response> {
  // Filter static file extension
  let mime = 'text/plain; charset=UTF-8;';
  if (path.endsWith('.js')) mime = 'application/javascript; charset=UTF-8;';
  else if (path.endsWith('.css')) mime = 'text/css; charset=UTF-8;';
  else if (path.endsWith('.html')) mime = 'text/html; charset=UTF-8;';
  else if (path.endsWith('.ico')) mime = 'image/x-icon';
  else
    return new Response(null, {
      headers: {
        'cache-control': 'public, max-age=14400',
      },
      status: 404,
    });

  try {
    const res = await fetch(path, {
      headers: req_headers,
      cf: {
        cacheEverything: true,
      },
    });
    // Append ETag and Cache
    const etag = res.headers.get('etag');
    const nres = new Response(res.body, {
      headers: {
        'content-type': mime,
        'cache-control': 'public, max-age=14400',
      },
      status: res.status,
    });
    if (etag) nres.headers.append('etag', etag);
    return nres;
  } catch (err) {
    return new Response('Internal server error.\n', {
      status: 500,
    });
  }
}
