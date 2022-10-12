/*
 * This file is part of paste.
 * Copyright (c) 2022 Joe Ma <rikkaneko23@gmail.com>
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
const PASTE_INDEX_HTML_URL = 'https://raw.githubusercontent.com/rikkaneko/paste/main/paste.html';
const UUID_LENGTH = 4;

export interface Env {
  PASTE_INDEX: KVNamespace;
  QRCODE: ServiceWorkerGlobalScope;
  AWS_ACCESS_KEY_ID: string;
  AWS_SECRET_ACCESS_KEY: string;
  ENDPOINT: string;
}

const API_SPEC_TEXT =
    `Paste service https://${SERVICE_URL}

[API Specification]
GET /                   Fetch the Web frontpage for uploading text/file [x]
GET /api                Fetch API specification

# Authentication support HTTP Basic access authentication (RFC 7617) or the x-pass header
GET /<uuid>             Fetch the paste by uuid [x]

# Currently, only the following options is supported for <option>,
# "settings": Fetch the paste information, add \`?qr=1\` to enable QR code generation for paste link.
# "download": Download paste as attachment
# "raw": Display paste as plain text
GET /<uuid>/<option>      Fetch the paste (code) in rendered HTML with syntax highlighting [ ]

# Only support multipart/form-data and raw request
# For form-data, u=<upload-data>, both title and content-type is deduced from the u
# Add \`?qr=1\` or qrcode=(on|true) using form-data to enable QR code generation for paste link.
# The following key is supported for both HTTP form request and headers, add the prefix "x-" for header keys in raw request
# title: File title, i.e. main.py
# content-type: The media type (MIME) of the data and encoding, i.e., text/plain; charset=UTF-8;
# pass: Paste password
# read-limit: Limit access times to paste to <read-limit>
# paste-type: Set paste type (Available: paste, link)
POST /                  Create new paste [x]

DELETE /<uuid>          Delete paste by uuid [x]
POST /<uuid>/settings   Update paste setting, i.e., passcode and valid time [ ]

# For paste with password protected, all API call related to the pastes requires additional x-pass header

* uuid: [A-z0-9]{${UUID_LENGTH}}

Supported Features
* Password protection
* Limit access times
* Generate QR code for paste link

[ ] indicated not implemented

Limitation
* Max. 10MB file size upload
* Paste will be kept for 28 days only by default

Last update on 11 Sept.
`;

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

    if (path === '/api' && method == 'GET') {
      return new Response(API_SPEC_TEXT, {
        headers: {
          'cache-control': 'public, max-age=172800',
        },
      });
    }

    if (path === '/') {
      switch (method) {
          // Fetch the HTML for uploading text/file
        case 'GET': {
          return await fetch(PASTE_INDEX_HTML_URL, {
            cf: {
              cacheEverything: true,
            },
          }).then(value => {
            return new Response(value.body, {
              // Add the correct content-type to response header
              headers: {
                'content-type': 'text/html; charset=UTF-8;',
                'cache-control': 'public, max-age=172800',
              },
            });
          });
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
          // Content-Type: multipart/form-data
          if (content_type.includes('multipart/form-data')) {
            const formdata = await request.formData();
            const data = formdata.get('u');
            const type = formdata.get('paste-type');
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
            if (typeof qr === 'string' && qr.toLowerCase() === 'true' || qr === 'on') {
              need_qrcode = true;
            }

            // Raw body
          } else {
            title = headers.get('x-title') || undefined;
            mime_type = headers.get('x-content-type') || undefined;
            password = headers.get('x-pass') || undefined;
            paste_type = headers.get('x-paste-type') || undefined;
            const count = headers.get('x-read-limit') || undefined;
            if (typeof count === 'string') {
              const n = parseInt(count);
              if (isNaN(n) || n <= 0) {
                return new Response('x-read-limit must be a positive integer.\n', {
                  status: 422,
                });
              }
              read_limit = n;
            }
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

          // Check password rules
          if (password && !check_password_rules(password)) {
            return new Response('Invalid password. ' +
                'Password must contain alphabets and digits only, and has a length of 4 or more.', {
              status: 422,
            });
          }

          // Check request.body size <= 10MB
          const size = buffer.byteLength;
          if (size > 10485760) {
            return new Response('Paste size must be under 10MB.\n', {
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
            return await get_paste_info(uuid, descriptor, env, is_browser, need_qrcode);
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
            const need_qrcode = searchParams.get('qr') === '1';
            return await get_paste_info(uuid, descriptor, env, is_browser, need_qrcode);
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
                    ...res.headers,
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

async function get_paste_info(uuid: string, descriptor: PasteIndexEntry, env: Env, use_html: boolean = true, need_qr: boolean = false): Promise<Response> {
  const date = new Date(descriptor.last_modified);
  const link = `https://${SERVICE_URL}/${uuid}`;
  let content = dedent`
    id: ${uuid}
    link: ${link}
    title: ${descriptor.title || '<empty>'}
    mime-type: ${descriptor.mime_type ?? '-'}
    size: ${descriptor.size} bytes (${to_human_readable_size(descriptor.size)})
    password: ${(!!descriptor.password)}
    editable: ${descriptor.editable ? descriptor.editable : true}
    remaining read count: ${descriptor.read_count_remain !== undefined ?
      descriptor.read_count_remain ? descriptor.read_count_remain : `0 (expired)` : '-'}
    created at ${date.toISOString()}
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
          ${(need_qr) ? `<img src="${'https://qrcode.nekoul.com/?' + new URLSearchParams({q: link, type: 'svg'})}"
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

interface PasteIndexEntry {
  title?: string,
  mime_type?: string,
  last_modified: number,
  size: number,
  password?: string,
  editable?: boolean, // Default: True
  read_count_remain?: number
  type?: string;
}