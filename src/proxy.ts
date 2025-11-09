/*
 * This file is part of paste.
 * Copyright (c) 2022-2025 Joe Ma <rikkaneko23@gmail.com>
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Lesser General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

// Proxy URI (Accept *.js, *.css, *.html, *.ico only)
// Use ETag and If-None-Match to cache file
export async function serve_static(path: string, req_headers?: Headers): Promise<Response> {
  // Filter static file extension
  let mime = 'text/plain; charset=UTF-8;';
  if (path.endsWith('.js')) mime = 'application/javascript; charset=UTF-8;';
  else if (path.endsWith('.css')) mime = 'text/css; charset=UTF-8;';
  else if (path.endsWith('.html')) mime = 'text/html; charset=UTF-8;';
  else if (path.endsWith('.ico')) mime = 'image/x-icon';
  else if (path.endsWith('.png')) mime = 'image/png';
  else if (path.endsWith('.jpg')) mime = 'image/jpg';
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
