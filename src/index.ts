/*
 * This file is part of paste.
 * Copyright (c) 2022-2023 Joe Ma <rikkaneko23@gmail.com>
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

import {AwsClient} from 'aws4fetch';
import {customAlphabet} from 'nanoid';
import {sha256} from 'js-sha256';
import dedent from 'dedent-js';

// Constants
const SERVICE_URL = 'pb.nekoul.com';
const PASTE_WEB_URL_v1 = 'https://raw.githubusercontent.com/rikkaneko/paste/main/web/v1';
const PASTE_WEB_URL = 'https://raw.githubusercontent.com/rikkaneko/paste/main/web/v2';
const UUID_LENGTH = 4;

export interface Env {
  PASTE_INDEX: KVNamespace;
  QRCODE: ServiceWorkerGlobalScope;
  AWS_ACCESS_KEY_ID: string;
  AWS_SECRET_ACCESS_KEY: string;
  ENDPOINT: string;
}

const gen_id = customAlphabet(
    '1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', UUID_LENGTH);

export default {
  async fetch(
      request: Request,
      env: Env,
      ctx: ExecutionContext,
  ): Promise<Response> {
    const {url, method, headers} = request;
    const {pathname, searchParams} = new URL(url);
    const path = pathname.replace(/\/+$/, '') || '/';
    let cache = caches.default;

    const agent = headers.get('user-agent') ?? '';
    // Detect if request from browsers
    const is_browser = ['Chrome', 'Mozilla', 'AppleWebKit', 'Safari', 'Gecko', 'Chromium'].some(v => agent.includes(v));

    const s3 = new AwsClient({
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    });

    // Special path
    if (path === '/favicon.ico' && method == 'GET') {
      return new Response(null, {
        headers: {
          'cache-control': 'public, max-age=172800',
        },
        status: 404,
      });
    }

    if (path === '/v1' && method == 'GET') {
      return await proxy_uri(PASTE_WEB_URL_v1 + '/paste.html');
    }

    if (/\/(js|css)\/.*$/.test(path) && method == 'GET') {
      return await proxy_uri(PASTE_WEB_URL + path);
    }

    if (path === '/') {
      switch (method) {
        case 'GET': {
          // Fetch the HTML for uploading text/file
          return await proxy_uri(PASTE_WEB_URL + '/paste.html');
        }

        // Create new paste
        case 'POST':
          const uuid = gen_id();
          let buffer: ArrayBuffer;
          let title: string | undefined;
          // Handle content-type
          const content_type = headers.get('content-type') || '';
          let mime_type: string | undefined;
          let password: string | undefined;
          let read_limit: number | undefined;
          let need_qrcode: boolean = false;
          let paste_type: string | undefined;
          let reply_json: boolean = false;
          // Content-Type: multipart/form-data (deprecated)
          if (content_type.includes('multipart/form-data')) {
            const formdata = await request.formData();
            const data: File | string | any = formdata.get('u');
            const type = formdata.get('paste-type');
            const file_title = formdata.get('title');
            if (data === null) {
              return new Response('Invalid request.\n', {
                status: 422,
              });
            }
            // File
            if (data instanceof File) {
              title = data.name || undefined;
              mime_type = data.type || undefined;
              buffer = await data.arrayBuffer();
              // Text
            } else {
              buffer = new TextEncoder().encode(data);
              mime_type = 'text/plain; charset=UTF-8;';
            }

            if (typeof file_title === 'string') title = file_title;
            if (typeof type === 'string') paste_type = type;

            // Set password
            const pass = formdata.get('pass');
            if (typeof pass === 'string') {
              password = pass || undefined;
            }

            const count = formdata.get('read-limit');
            if (typeof count === 'string') {
              const n = parseInt(count);
              if (isNaN(n) || n <= 0) {
                return new Response('Invalid read-limit field, must be a positive integer.\n', {
                  status: 422,
                });
              }
              read_limit = n;
            }

            // Check if qrcode generation needed
            const qr = formdata.get('qrcode');
            if (typeof qr === 'string' && qr === '1') {
              need_qrcode = true;
            }

            // Check reply format
            const json = formdata.get('json');
            if (typeof json === 'string' && json === '1') {
              reply_json = true;
            }

            // Paste API v2
          } else {
            title = headers.get('x-paste-title') || undefined;
            mime_type = headers.get('x-paste-content-type') || undefined;
            password = headers.get('x-paste-pass') || undefined;
            paste_type = headers.get('x-paste-type') || undefined;
            need_qrcode = headers.get('x-paste-qr') === '1';
            reply_json = headers.get('x-json') === '1';
            const count = headers.get('x-paste-read-limit') || '';
            const n = parseInt(count);
            if (isNaN(n) || n <= 0) {
              return new Response('x-paste-read-limit must be a positive integer.\n', {
                status: 422,
              });
            }
            read_limit = n;
            buffer = await request.arrayBuffer();
          }

          // Check if qrcode generation needed
          if (searchParams.get('qr') === '1') {
            need_qrcode = true;
          }

          // Validate paste type parameter
          switch (paste_type) {
            case 'link':
              mime_type = 'text/x-uri';
              paste_type = 'link';
              break;

            case 'paste':
            case undefined:
              paste_type = undefined;
              break;

            default:
              return new Response('Unknown paste type.\n', {
                status: 422,
              });
          }

          // Check file title rules
          if (title && /^.*[\\\/]/.test(title))
            return new Response('Invalid title', {
              status: 422,
            });

          // Check password rules
          if (password && !check_password_rules(password)) {
            return new Response('Invalid password. ' +
                'Password must contain alphabets and digits only, and has a length of 4 or more.', {
              status: 422,
            });
          }

          // Check request.body size <= 25MB
          const size = buffer.byteLength;
          if (size > 26214400) {
            return new Response('Paste size must be under 25MB.\n', {
              status: 422,
            });
          }

          // Check request.body size not empty
          if (buffer.byteLength == 0) {
            return new Response('Paste cannot be empty.\n', {
              status: 422,
            });
          }

          const res = await s3.fetch(`${env.ENDPOINT}/${uuid}`, {
            method: 'PUT',
            body: buffer,
          });

          if (res.ok) {
            // Upload success
            const descriptor: PasteIndexEntry = {
              title: title || undefined,
              last_modified: Date.now(),
              password: password ? sha256(password).slice(0, 16) : undefined,
              read_count_remain: read_limit ?? undefined,
              mime_type: mime_type || undefined,
              type: paste_type,
              size,
            };

            // Key will be expired after 28 day if unmodified
            ctx.waitUntil(env.PASTE_INDEX.put(uuid, JSON.stringify(descriptor), {expirationTtl: 2419200}));
            return await get_paste_info(uuid, descriptor, env, is_browser, need_qrcode, reply_json);
          } else {
            return new Response('Unable to upload the paste.\n', {
              status: 500,
            });
          }

      }

    } else if (path.length >= UUID_LENGTH + 1) {
      // RegExpr to match /<uuid>/<option>
      const found = path.match('/(?<uuid>[A-z0-9]+)(?:/(?<option>[A-z]+))?$');
      if (found === null) {
        return new Response('Invalid path.\n', {
          status: 403,
        });
      }
      // @ts-ignore
      const {uuid, option} = found.groups;
      // UUID format: [A-z0-9]{UUID_LENGTH}
      if (uuid.length !== UUID_LENGTH) {
        return new Response('Invalid UUID.\n', {
          status: 442,
        });
      }
      const val = await env.PASTE_INDEX.get(uuid);
      if (val === null) {
        return new Response('Paste not found.\n', {
          status: 404,
        });
      }
      const descriptor: PasteIndexEntry = JSON.parse(val);

      // Handling /<uuid>/settings
      if (option === 'settings') {
        switch (method) {
          case 'GET': {
            const need_qrcode = searchParams.get('qr') === '1' || headers.get('x-qr') === '1';
            const reply_json = searchParams.get('json') === '1' || headers.get('x-json') === '1';
            return await get_paste_info(uuid, descriptor, env, is_browser, need_qrcode, reply_json);
          }

          case 'POST': {
            // TODO Implement paste setting update
            return new Response('Service is under maintainance.\n', {
              status: 422,
            });
          }
        }

      }

      switch (method) {
          // Fetch the paste by uuid
        case 'GET': {
          // Check password if needed
          if (descriptor.password !== undefined) {
            if (headers.has('Authorization')) {
              let cert = get_basic_auth(headers);
              // Error occurred when parsing the header
              if (cert === null) {
                return new Response('Invalid Authorization header.', {
                  status: 400,
                });
              }
              // Check password and username should be empty
              if (cert[0].length != 0 || descriptor.password !== sha256(cert[1]).slice(0, 16)) {
                return new Response('Incorrect password.\n', {
                  status: 401,
                  headers: {
                    'WWW-Authenticate': 'Basic realm="Requires password"',
                  },
                });
              }
              // x-pass header
            } else if (headers.has('x-pass')) {
              if (descriptor.password !== sha256(headers.get('x-pass')!).slice(0, 16)) {
                return new Response('Incorrect password.\n');
              }
            } else {
              return new Response('This paste requires password.\n', {
                status: 401,
                headers: {
                  'WWW-Authenticate': 'Basic realm="Requires password"',
                },
              });
            }
          }

          // Check if access_count_remain entry present
          if (descriptor.read_count_remain !== undefined) {
            if (descriptor.read_count_remain <= 0) {
              return new Response('Paste expired.\n', {
                status: 410,
              });
            }
            descriptor.read_count_remain--;
            ctx.waitUntil(env.PASTE_INDEX.put(uuid, JSON.stringify(descriptor), {
              expiration: descriptor.last_modified / 1000 + 2419200,
            }));
          }

          // Enable CF cache for authorized request
          // Match in existing cache
          let res = await cache.match(request.url);
          if (res === undefined) {
            // Fetch form origin if not hit cache
            let origin = await s3.fetch(`${env.ENDPOINT}/${uuid}`, {
              method: 'GET',
            });

            res = new Response(origin.body);

            if (res.status == 404) {
              // UUID exists in index but not found in remote object storage service, probably expired
              // Remove expired key
              ctx.waitUntil(env.PASTE_INDEX.delete(uuid));
              // Invalidate CF cache
              ctx.waitUntil(cache.delete(url));
              return new Response('Paste expired.\n', {
                status: 410,
              });
            } else if (!res.ok) {
              // Other error
              return new Response('Internal server error.\n', {
                status: 500,
              });
            }

            res.headers.set('cache-control', 'public, max-age=18000');
            res.headers.set('content-disposition',
                `inline; filename="${encodeURIComponent(descriptor.title ?? uuid)}"`);

            if (descriptor.mime_type)
              res.headers.set('content-type', descriptor.mime_type);
            // Let the browser guess the content
            else res.headers.delete('content-type');

            // Handle option
            if (option === 'raw') res.headers.delete('content-type');
            else if (option === 'download')
              res.headers.set('content-disposition',
                  `attachment; filename="${encodeURIComponent(descriptor.title ?? uuid)}"`);

            // Link redirection
            else if (descriptor.type === 'link' || option === 'link') {
              const content = await res.clone().arrayBuffer();
              try {
                const href = new TextDecoder().decode(content);
                new URL(href);
                res.headers.set('location', href);
                res = new Response(res.body, {
                  status: 301,
                  headers: {
                    location: href,
                    ...Object.entries(res.headers),
                  },
                });
              } catch (err) {
                if (err instanceof TypeError) {
                  res = new Response('Invalid URL.', {
                    status: 422,
                  });
                }
              }
            }

            // res.body cannot be read twice
            // Do not block when writing to cache
            ctx.waitUntil(cache.put(url, res.clone()));
            return res;
          }

          // Cache hit
          let {readable, writable} = new TransformStream();
          res.body!.pipeTo(writable);
          return new Response(readable, res);
        }

          // Delete paste by uuid
        case 'DELETE': {
          if (descriptor.editable !== undefined && !descriptor.editable) {
            return new Response('This paste is immutable.\n', {
              status: 405,
            });
          }

          // Check password if needed
          if (descriptor.password !== undefined) {
            if (headers.has('x-pass')) {
              const pass = headers.get('x-pass');
              if (descriptor.password !== sha256(pass!).slice(0, 16)) {
                return new Response('Incorrect password.\n', {
                  status: 403,
                });
              }
            } else {
              return new Response('This operation requires password.\n', {
                status: 401,
              });
            }
          }

          let res = await s3.fetch(`${env.ENDPOINT}/${uuid}`, {
            method: 'DELETE',
          });

          if (res.ok) {
            ctx.waitUntil(env.PASTE_INDEX.delete(uuid));
            // Invalidate CF cache
            ctx.waitUntil(cache.delete(url));
            return new Response('OK\n');
          } else {
            return new Response('Unable to process such request.\n', {
              status: 500,
            });
          }
        }
      }
    }

    // Default response
    return new Response('Invalid path.\n', {
      status: 403,
    });
  },
};

async function get_paste_info(uuid: string, descriptor: PasteIndexEntry, env: Env,
                              use_html: boolean = true, need_qr: boolean = false, reply_json = false): Promise<Response> {
  const created = new Date(descriptor.last_modified);
  const expired = new Date(descriptor.last_modified + 2419200000);
  const link = `https://${SERVICE_URL}/${uuid}`;
  const paste_info = {
    uuid,
    link,
    link_qr: 'https://qrcode.nekoul.com/?' + new URLSearchParams({q: link, type: 'svg'}),
    type: descriptor.type ?? 'paste',
    title: descriptor.title?.trim(),
    mime_type: descriptor.mime_type,
    human_readable_size: `${to_human_readable_size(descriptor.size)}`,
    size: descriptor.size,
    password: !!descriptor.password,
    read_count_remain: descriptor.read_count_remain,
    created: created.toISOString(),
    expired: expired.toISOString(),
  };

  // Reply with JSON
  if (reply_json) {
    return new Response(JSON.stringify(paste_info), {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      },
    });
  }

  // Plain text reply
  let content = dedent`
    uuid: ${uuid}
    link: ${link}
    type: ${paste_info.type ?? 'paste'}
    title: ${paste_info.title || '-'}
    mime-type: ${paste_info.mime_type ?? '-'}
    size: ${paste_info.size} bytes (${paste_info.human_readable_size})
    password: ${paste_info.password}
    remaining read count: ${paste_info.read_count_remain !== undefined ?
      paste_info.read_count_remain ? paste_info.read_count_remain : `0 (expired)` : '-'}
    created at ${paste_info.created}
    expired at ${paste_info.expired}
    `;

  // Browser response
  if (use_html) {
    const html = dedent`
      <!DOCTYPE html>
        <html lang="en">
        <head>
          <meta charset="UTF-8">
          <title>Paste</title>
        </head>
        <body>
          <pre style="word-wrap: break-word; white-space: pre-wrap;
            font-family: 'Fira Mono', monospace; font-size: 16px;">${content}</pre>
          ${(need_qr) ? `<img src="${paste_info.link_qr}"
            alt="${link}" style="max-width: 280px">` : ''} 
        </body>
      </html>
    `;

    return new Response(html, {
      headers: {
        'content-type': 'text/html; charset=UTF-8;',
        'cache-control': 'no-store',
      },
    });
  }

  // Console response
  if (need_qr) {
    // Cloudflare currently does not support doing a subrequest to the same zone, use service binding instead
    const res = await env.QRCODE.fetch('https://qrcode.nekoul.com?' + new URLSearchParams({
      q: link,
      type: 'utf8',
    }));

    if (res.ok) {
      const qrcode = await res.text();
      content += '\n';
      content += qrcode;
    }
  }

  content += '\n';
  return new Response(content, {
    headers: {
      'cache-control': 'no-store',
    },
  });
}

function check_password_rules(password: string): boolean {
  return password.match('^[A-z0-9]{4,}$') !== null;
}

// Extract username and password from Basic Authorization header
function get_basic_auth(headers: Headers): [string, string] | null {
  if (headers.has('Authorization')) {
    const auth = headers.get('Authorization');
    const [scheme, encoded] = auth!.split(' ');
    // Validate authorization header format
    if (!encoded || scheme !== 'Basic') {
      return null;
    }
    // Decode base64 to string (UTF-8)
    const buffer = Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
    const decoded = new TextDecoder().decode(buffer).normalize();
    const index = decoded.indexOf(':');

    // Check if user & password are split by the first colon and MUST NOT contain control characters.
    if (index === -1 || decoded.match('[\\0-\x1F\x7F]')) {
      return null;
    }

    return [decoded.slice(0, index), decoded.slice(index + 1)];

  } else {
    return null;
  }
}

function to_human_readable_size(bytes: number): string {
  let size = bytes + ' bytes';
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  for (let i = 0, approx = bytes / 1024; approx > 1; approx /= 1024, i++) {
    size = approx.toFixed(3) + ' ' + units[i];
  }
  return size;
}

// Proxy URI (limit to html/js/css)
async function proxy_uri(path: string, cf: RequestInitCfProperties = {cacheEverything: true}) {
  // Fix content type
  let file_type = 'text/plain';
  if (path.endsWith('.js')) file_type = 'application/javascript';
  if (path.endsWith('.css')) file_type = 'text/css';
  if (path.endsWith('.html')) file_type = 'text/html';

  return await fetch(path, {
    cf,
  }).then(value => {
    return new Response(value.body, {
      // Add the correct content-type to response header
      headers: {
        'content-type': `${file_type}; charset=UTF-8;`,
        'cache-control': 'public, max-age=172800',
      },
    });
  });
}

interface PasteIndexEntry {
  title?: string,
  mime_type?: string,
  last_modified: number,
  size: number,
  password?: string,
  editable?: boolean, // Default: False (unsupported)
  read_count_remain?: number
  type?: string;
}