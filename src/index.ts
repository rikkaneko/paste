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

import { AwsClient } from 'aws4fetch';
import { sha256 } from 'js-sha256';
import { Router, error, cors } from 'itty-router';
import { ERequest, Env } from './types';
import { serve_static } from './proxy';
import { check_password_rules, get_paste_info, get_basic_auth, gen_id } from './utils';
import constants, { fetch_constant } from './constant';
import { get_presign_url, router as large_upload } from './api/large_upload';
import v2api from './v2/api';
import { PasteIndexEntry, PasteTypeStr, PasteTypeFrom, PasteType } from './v2/schema';

// In favour of new cors() in itty-router v5
const { preflight, corsify } = cors({
  origin: (o) => {
    if (constants?.CORS_DOMAIN) {
      return o?.endsWith(constants.CORS_DOMAIN) ? o : undefined;
    }
  },
  credentials: true,
  allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
});

const router = Router<ERequest, [Env, ExecutionContext]>({
  before: [
    (_, env) => {
      fetch_constant(env);
    },
    preflight,
  ],
  catch: error,
  finally: [
    (res: Response) => {
      if (res.headers.has('server')) return res;
      return corsify(
        new Response(res.body, {
          status: res.status,
          statusText: res.statusText,
          headers: new Headers(res.headers),
        })
      );
    },
  ],
});

// Shared common properties to all route
router.all('*', (request) => {
  const { headers } = request;
  // Detect if request from browsers
  const agent = headers.get('user-agent') ?? '';
  request.is_browser = ['Chrome', 'Mozilla', 'AppleWebKit', 'Safari', 'Gecko', 'Chromium'].some((v) =>
    agent.includes(v)
  );
  // Append the origin/referer
  request.origin = headers.get('referer') ?? undefined;
});

/* Static file path */
// Web homepage
router.get('/', (request, env, ctx) => {
  return serve_static(env.PASTE_WEB_URL + '/paste.html', request.headers);
});

// Favicon
router.get('/favicon.ico', () => {
  return new Response(null, {
    headers: {
      'cache-control': 'public, max-age=172800',
    },
    status: 404,
  });
});

// Web script and style file
router.get('/static/*', (request, env, ctx) => {
  const { url } = request;
  const { pathname } = new URL(url);
  const path = pathname.replace(/\/+$/, '') || '/';
  return serve_static(env.PASTE_WEB_URL + path, request.headers);
});

// Create new paste (10MB limit)
router.post('/', async (request, env, ctx) => {
  const { headers } = request;
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
  // Content-Type: multipart/form-data
  if (content_type.includes('multipart/form-data')) {
    const formdata = await request.formData();
    const data: File | string | any = formdata.get('u');
    const type = formdata.get('paste-type');
    const file_title = formdata.get('title');
    const file_meta = formdata.get('mime-type');
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
      // @ts-ignore
      buffer = new TextEncoder().encode(data);
      mime_type = 'text/plain; charset=UTF-8;';
    }

    if (typeof file_title === 'string') title = file_title;
    if (typeof file_meta === 'string') mime_type = file_meta;
    if (typeof type === 'string') {
      if (type === 'paste' || type === 'link') paste_type = type;
      else {
        return new Response('paste-type can only be "paste" or "link".\n', {
          status: 422,
        });
      }
    }

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
  } else {
    // HTTP API
    title = headers.get('x-paste-title') || undefined;
    mime_type = headers.get('x-paste-content-type') || undefined;
    password = headers.get('x-pass') || undefined;
    paste_type = headers.get('x-paste-type') || undefined;
    need_qrcode = headers.get('x-paste-qr') === '1';
    reply_json = headers.get('x-json') === '1';
    const count = headers.get('x-paste-read-limit') || undefined;
    if (count) {
      const n = parseInt(count);
      if (isNaN(n) || n <= 0) {
        return new Response('x-paste-read-limit must be a positive integer.\n', {
          status: 422,
        });
      }
      read_limit = n;
    }

    buffer = await request.arrayBuffer();
  }

  // Check if qrcode generation needed
  if (request.query?.qr === '1') {
    need_qrcode = true;
  }

  // Check file title rules
  if (title && /^.*[\\\/]/.test(title))
    return new Response('Invalid title', {
      status: 422,
    });

  // Check password rules
  if (password && !check_password_rules(password)) {
    return new Response('Password can only contain alphabets and digits only.', {
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

  const s3 = new AwsClient({
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    service: 's3', // required
  });

  const res = await s3.fetch(`${env.ENDPOINT}/${uuid}`, {
    method: 'PUT',
    body: buffer,
  });

  // Default paste type
  paste_type = paste_type ? paste_type : 'paste';

  if (paste_type === 'link') {
    mime_type = 'text/x-uri';
  }

  // Validate paste type parameter
  if (paste_type !== 'paste' && paste_type !== 'link') {
    return new Response('Unknown paste type.\n', {
      status: 422,
    });
  }

  if (res.ok) {
    // Upload success
    const current_time = Date.now();
    // Temporary expiration time
    const expiration = new Date(Date.now() + 2419200 * 1000).getTime(); // default 28 days
    const descriptor: PasteIndexEntry = {
      uuid,
      title: title || undefined,
      password: password ? sha256(password).slice(0, 16) : undefined,
      access_n: 0,
      max_access_n: read_limit ?? undefined,
      mime_type: mime_type || undefined,
      paste_type: PasteTypeFrom(paste_type),
      file_size: size,
      created_at: current_time,
      expired_at: expiration,
    };

    // Key will be expired after 28 day if unmodified
    ctx.waitUntil(env.PASTE_INDEX.put(uuid, JSON.stringify(descriptor), { expirationTtl: 2419200 }));
    return await get_paste_info(uuid, descriptor, env, request.is_browser, need_qrcode, reply_json);
  } else {
    return new Response('Unable to upload the paste.\n', {
      status: 500,
    });
  }
});

// Handle large upload (> 25MB)
router.all('/api/large_upload/*', large_upload.fetch);

/* New Paste v2 RESTful API */
router.all('/v2/*', v2api.fetch);

// Fetch paste by uuid [4-digit UUID]
router.get('/:uuid/:option?', async (request, env, ctx) => {
  const { headers } = request;
  const { uuid, option } = request.params;
  // UUID format: [A-z0-9]{UUID_LENGTH}
  if (uuid.length !== constants.UUID_LENGTH) {
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
    const need_qrcode = request.query?.qr === '1' || headers.get('x-qr') === '1';
    const reply_json = request.query?.json === '1' || headers.get('x-json') === '1';
    return await get_paste_info(uuid, descriptor, env, request.is_browser, need_qrcode, reply_json);
  }

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
  if (descriptor.max_access_n !== undefined) {
    if (descriptor.access_n > descriptor.max_access_n) {
      return new Response('Paste expired.\n', {
        status: 410,
      });
    }
  }

  descriptor.access_n++;
  ctx.waitUntil(
    env.PASTE_INDEX.put(uuid, JSON.stringify(descriptor), {
      expiration: descriptor.expired_at / 1000,
    })
  );

  // New added in 2.0
  // Handle large_paste
  // Use presigned url generation only if the file size larger than 200MB, use request forwarding instead
  if (descriptor.paste_type === PasteType.large_paste) {
    if (descriptor.upload_track?.pending_upload) {
      return new Response('This paste is not yet finalized.\n', {
        status: 400,
      });
    }

    if (descriptor.file_size >= 209715200) {
      const signed_url = await get_presign_url(uuid, descriptor);
      if (signed_url == null) {
        return new Response('No available download endpoint.\n', {
          status: 404,
        });
      }

      ctx.waitUntil(
        env.PASTE_INDEX.put(uuid, JSON.stringify(descriptor), {
          expiration: descriptor.expired_at / 1000,
        })
      );

      return new Response(null, {
        status: 301,
        headers: {
          location: signed_url,
          'cache-control': 'no-store',
        },
      });
    }
  }

  // Enable CF cache for authorized request
  // Match in existing cache
  const cache = caches.default;
  const match_etag = headers.get('If-None-Match') || undefined;
  // Define the Request object as cache key
  const req_key = new Request(`${env.SERVICE_URL}/${uuid}`, {
    method: 'GET',
    headers: match_etag
      ? {
          // ETag to cache file
          'if-none-match': match_etag,
        }
      : undefined,
  });

  let res = await cache.match(req_key);
  if (res === undefined) {
    // Use althernative endpoint and credentials for large_type
    const endpoint = descriptor.paste_type == PasteType.large_paste ? env.LARGE_DOWNLOAD_ENDPOINT : env.ENDPOINT;
    const access_key_id =
      descriptor.paste_type == PasteType.large_paste ? env.LARGE_AWS_ACCESS_KEY_ID! : env.AWS_ACCESS_KEY_ID;
    const secret_access_key =
      descriptor.paste_type == PasteType.large_paste ? env.LARGE_AWS_SECRET_ACCESS_KEY! : env.AWS_SECRET_ACCESS_KEY;

    const s3 = new AwsClient({
      accessKeyId: access_key_id,
      secretAccessKey: secret_access_key,
      service: 's3', // required
    });

    // Fetch form origin if not hit cache
    let origin = await s3.fetch(`${endpoint}/${uuid}`, {
      method: 'GET',
      headers: match_etag
        ? {
            'if-none-match': match_etag,
          }
        : undefined,
    });

    // Reserve ETag header
    const etag = origin.headers.get('etag');
    res = new Response(origin.body, {
      status: origin.status,
      headers:
        etag !== null
          ? {
              etag,
            }
          : undefined,
    });

    if (res.status == 404) {
      // UUID exists in index but not found in remote object storage service, probably expired
      // Remove expired key
      ctx.waitUntil(env.PASTE_INDEX.delete(uuid));
      // Invalidate CF cache
      ctx.waitUntil(cache.delete(req_key));
      return new Response('Paste expired.\n', {
        status: 410,
      });
    } else if (!res.ok && res.status !== 304) {
      // Other error
      return new Response('Internal server error.\n', {
        status: 500,
      });
    }

    res.headers.set('cache-control', 'public, max-age=18000');
    res.headers.set('content-disposition', `inline; filename*=UTF-8''${encodeURIComponent(descriptor.title ?? uuid)}`);

    if (descriptor.mime_type) res.headers.set('content-type', descriptor.mime_type);
    // Let the browser guess the content
    else res.headers.delete('content-type');

    // Link redirection
    if (descriptor.paste_type == PasteType.link) {
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
    if (res.ok) ctx.waitUntil(cache.put(req_key, res.clone()));
    // Handle option
    if (option === 'raw') res.headers.delete('content-type');
    else if (option === 'download')
      res.headers.set(
        'content-disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(descriptor.title ?? uuid)}`
      );
    return res;
  }

  // Cache hit
  // Matched Etag, no body
  if (res.status == 304) return res;
  let { readable, writable } = new TransformStream();
  res.body?.pipeTo(writable);
  const nres = new Response(readable, res);
  // Handle option
  if (option === 'raw') nres.headers.delete('content-type');
  else if (option === 'download')
    nres.headers.set(
      'content-disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(descriptor.title ?? uuid)}`
    );
  return nres;
});

// Update paste metadata
router.post('/:uuid/:options', () => {
  // TODO Implement paste setting update
  return new Response('Service is under maintainance.\n', {
    status: 422,
  });
});

// Delete paste by uuid
router.delete('/:uuid', async (request, env, ctx) => {
  const { headers } = request;
  const { uuid } = request.params;
  // UUID format: [A-z0-9]{UUID_LENGTH}
  if (uuid.length !== constants.UUID_LENGTH) {
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

  const cache = caches.default;
  // Distinguish the endpoint for large_paste and normal paste
  if (descriptor.paste_type == PasteType.large_paste) {
    if (!env.LARGE_AWS_ACCESS_KEY_ID || !env.LARGE_AWS_SECRET_ACCESS_KEY || !env.LARGE_ENDPOINT) {
      return new Response('Unsupported paste type.\n', {
        status: 501,
      });
    }
  }

  // Use althernative endpoint and credentials for large_type
  const endpoint = descriptor.paste_type == PasteType.large_paste ? env.LARGE_DOWNLOAD_ENDPOINT : env.ENDPOINT;
  const access_key_id =
    descriptor.paste_type == PasteType.large_paste ? env.LARGE_AWS_ACCESS_KEY_ID! : env.AWS_ACCESS_KEY_ID;
  const secret_access_key =
    descriptor.paste_type == PasteType.large_paste ? env.LARGE_AWS_SECRET_ACCESS_KEY! : env.AWS_SECRET_ACCESS_KEY;

  const s3 = new AwsClient({
    accessKeyId: access_key_id,
    secretAccessKey: secret_access_key,
    service: 's3', // required
  });

  let res = await s3.fetch(`${endpoint}/${uuid}`, {
    method: 'DELETE',
  });

  if (res.ok) {
    ctx.waitUntil(env.PASTE_INDEX.delete(uuid));
    // Invalidate CF cache
    ctx.waitUntil(cache.delete(new Request(`${env.SERVICE_URL}/${uuid}`)));
    return new Response('OK\n');
  } else {
    return new Response('Unable to process such request.\n', {
      status: 500,
    });
  }
});

// Fallback route
router.all('*', () => {
  return new Response('Invalid path.\n', {
    status: 403,
  });
});

export default {
  fetch: (req: ERequest, env: Env, ctx: ExecutionContext) =>
    router
      // Update with itty-router 5.x
      .fetch(req, env, ctx),
};
