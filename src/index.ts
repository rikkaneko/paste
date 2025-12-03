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

import { sha256 } from 'js-sha256';
import { Router, error, cors } from 'itty-router';
import { ERequest, Env } from './types';
import { serve_static } from './proxy';
import { check_password_rules, get_paste_info, get_auth, gen_id } from './utils';
import { get_presign_url, router as large_upload } from './api/large_upload';
import v2api from './v2/api';
import { PasteIndexEntry, PasteTypeFrom, PasteType } from './v2/schema';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import Config from './config';

// In favour of new cors() in itty-router v5
const { preflight, corsify } = cors({
  origin: (origin) => {
    const allowed = Config.get()
      .config()
      .cors_domain?.some((domain) => {
        if (origin === domain || (domain.startsWith('*.') && origin?.endsWith(domain.slice(1))) || domain === '*')
          return true;
      });
    return allowed ? origin : undefined;
  },
  credentials: true,
  allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowHeaders: ['x-amz-checksum-sha256'],
});

const router = Router<ERequest, [Env, ExecutionContext]>({
  before: [
    async (req, env) => {
      try {
        // Load service config
        await Config.from_kv(env.PASTE_INDEX, env.CONFIG_NAME ?? 'config', env);
      } catch (e) {
        return new Response(`Invalid service config: ${(e as Error).message} \n`, {
          status: 500,
        });
      }
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
  request.origin = headers.get('origin') ?? headers.get('referer') ?? undefined;
});

/* Static file path */
// Web homepage
router.get('/', (request, env, ctx) => {
  const frontend_url = Config.get().config().frontend_url;
  if (!frontend_url) {
    return new Response('Invalid path.\n', {
      status: 403,
    });
  }
  return serve_static(frontend_url + '/paste.html', request.headers);
});

// Favicon
router.get('/favicon.png', (request, env, ctx) => {
  const frontend_url = Config.get().config().frontend_url;
  if (!frontend_url) {
    return new Response('Invalid path.\n', {
      status: 403,
    });
  }
  return serve_static(frontend_url + '/favicon.png', request.headers);
});

// Web script and style file
router.get('/static/*', (request, env, ctx) => {
  const { url } = request;
  const { pathname } = new URL(url);
  const path = pathname.replace(/\/+$/, '') || '/';
  const frontend_url = Config.get().config().frontend_url;
  if (!frontend_url) {
    return new Response('Invalid path.\n', {
      status: 403,
    });
  }
  return serve_static(frontend_url + path, request.headers);
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

  const config = Config.get();
  const storage = config.filter_storage('default');
  if (!storage) {
    return new Response('Invalid service config\n', {
      status: 500,
    });
  }

  // Check request.body size <= 10MB
  const size = buffer.byteLength;
  if (size > storage.max_file_size) {
    return new Response(`Paste size must be under ${to_human_readable_size(storage.max_file_size)}.\n`, {
      status: 422,
    });
  }

  // Check request.body size not empty
  if (buffer.byteLength == 0) {
    return new Response('Paste cannot be empty.\n', {
      status: 422,
    });
  }

  const s3 = new S3Client({
    region: storage.region,
    endpoint: storage.endpoint,
    credentials: {
      accessKeyId: storage.access_key_id,
      secretAccessKey: storage.secret_access_key,
    },
    forcePathStyle: true,
  });

  const res = await s3.send(
    new PutObjectCommand({
      Bucket: storage.bucket_name,
      Key: uuid,
      Body: buffer,
    })
  );

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

  if (res.$metadata.httpStatusCode === 200) {
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
    return await get_paste_info(uuid, descriptor, request.is_browser, need_qrcode, reply_json);
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
  const config = Config.get().config();
  // UUID format: [A-z0-9]{UUID_LENGTH}
  if (uuid.length !== config.uuid_length) {
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
    return await get_paste_info(uuid, descriptor, request.is_browser, need_qrcode, reply_json);
  }

  // Check password if needed
  if (descriptor.password !== undefined) {
    let cert = get_auth(request);
    if (cert == null) {
      return new Response('This paste requires password.\n', {
        status: 401,
        headers: {
          'WWW-Authenticate': 'Basic realm="Requires password"',
        },
      });
    } else if (descriptor.password !== sha256(cert).slice(0, 16)) {
      return new Response('Incorrect password.\n', {
        status: 401,
        headers: {
          'WWW-Authenticate': 'Basic realm="Requires password"',
        },
      });
    }
  }

  // Check if access_count_remain entry present
  if (descriptor.max_access_n !== undefined) {
    if (descriptor.access_n >= descriptor.max_access_n) {
      return new Response('Paste expired.\n', {
        status: 410,
      });
    }
  }

  descriptor.access_n++;
  ctx.waitUntil(
    env.PASTE_INDEX.put(uuid, JSON.stringify(descriptor), {
      expirationTtl: descriptor.expired_at / 1000,
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

    // Redirect to presigned url if file size larger than 100MB
    if (descriptor.file_size >= 104857600) {
      const signed_url = await get_presign_url(uuid, descriptor);
      if (signed_url == null) {
        return new Response('No available download endpoint.\n', {
          status: 404,
        });
      }

      ctx.waitUntil(
        env.PASTE_INDEX.put(uuid, JSON.stringify(descriptor), {
          expirationTtl: descriptor.expired_at / 1000,
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
  const req_key = new Request(`${config.public_url}/${uuid}`, {
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
    const paste_type = descriptor.paste_type == PasteType.large_paste ? 'large' : 'default';
    const storage = Config.get().filter_storage(paste_type);
    if (!storage) {
      return new Response('Internal server error.\n', {
        status: 500,
      });
    }

    const s3 = new S3Client({
      region: storage.region,
      endpoint: storage.endpoint,
      credentials: {
        accessKeyId: storage.access_key_id,
        secretAccessKey: storage.secret_access_key,
      },
      forcePathStyle: true,
    });

    const origin = await s3.send(
      new GetObjectCommand({
        Bucket: storage.bucket_name,
        Key: uuid,
        IfNoneMatch: match_etag,
      })
    );

    // Reserve ETag header
    const etag = origin.ETag;
    res = new Response(origin.Body, {
      status: origin.$metadata.httpStatusCode,
      headers: etag ? { etag } : undefined,
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

// Delete paste by uuid
router.delete('/:uuid', async (request, env, ctx) => {
  const { headers } = request;
  const { uuid } = request.params;
  const config = Config.get();
  // UUID format: [A-z0-9]{UUID_LENGTH}
  if (uuid.length !== config.config().uuid_length) {
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
  const paste_type = descriptor.paste_type == PasteType.large_paste ? 'large' : 'default';
  const storage = Config.get().filter_storage(paste_type);
  if (!storage) {
    return new Response('Unsupported paste type.\n', {
      status: 500,
    });
  }

  const s3 = new S3Client({
    region: storage.region,
    endpoint: storage.endpoint,
    credentials: {
      accessKeyId: storage.access_key_id,
      secretAccessKey: storage.secret_access_key,
    },
    forcePathStyle: true,
  });

  const res = await s3.send(
    new DeleteObjectCommand({
      Bucket: storage.bucket_name,
      Key: uuid,
    })
  );

  if (res.$metadata.httpStatusCode === 200 || res.$metadata.httpStatusCode === 204) {
    ctx.waitUntil(env.PASTE_INDEX.delete(uuid));
    // Invalidate CF cache
    ctx.waitUntil(cache.delete(new Request(`${config.config().public_url}/${uuid}`)));
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
function to_human_readable_size(max_file_size: number) {
  throw new Error('Function not implemented.');
}

