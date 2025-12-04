/*
 * This file is part of paste.
 * Copyright (c) 2022-2024 Joe Ma <rikkaneko23@gmail.com>
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

import dedent from 'dedent-js';
import { customAlphabet } from 'nanoid';
import { ERequest } from './types';
import { PasteIndexEntry, PasteType, PasteTypeStr } from './v2/schema';
import Config from './config';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export function gen_id(): string {
  return customAlphabet(
    '1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',
    Config.get().config().uuid_length
  )();
}

// Paste API Response (v1)
export function get_paste_info_obj(uuid: string, descriptor: PasteIndexEntry) {
  const created = new Date(descriptor.created_at);
  const expired = new Date(descriptor.expired_at);
  const link = `${Config.get().config().public_url}/${uuid}`;
  const paste_info = {
    uuid,
    link,
    link_qr: 'https://qrcode.nekoid.cc/?' + new URLSearchParams({ q: link, type: 'svg' }),
    type: PasteTypeStr(descriptor.paste_type),
    title: descriptor.title?.trim(),
    mime_type: descriptor.mime_type,
    human_readable_size: `${to_human_readable_size(descriptor.file_size)}`,
    size: descriptor.file_size,
    password: !!descriptor.password,
    access_n: descriptor.access_n,
    max_access_n: descriptor.max_access_n,
    created: created.toISOString(),
    expired: expired.toISOString(),
  };
  return paste_info;
}

export async function get_paste_info(
  uuid: string,
  descriptor: PasteIndexEntry,
  use_html: boolean = true,
  need_qr: boolean = false,
  reply_json = false
): Promise<Response> {
  const paste_info = get_paste_info_obj(uuid, descriptor);

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
    link: ${paste_info.link}
    type: ${paste_info.type ?? 'paste'}
    title: ${paste_info.title || '-'}
    mime-type: ${paste_info.mime_type ?? '-'}
    size: ${paste_info.size} bytes (${paste_info.human_readable_size})
    password: ${paste_info.password}
    access times: ${
      paste_info.max_access_n !== undefined
        ? paste_info.max_access_n - paste_info.access_n > 0
          ? `${paste_info.access_n} / ${paste_info.max_access_n}`
          : `${paste_info.access_n} / ${paste_info.max_access_n} (expired)`
        : paste_info.access_n
    }
    max_access_n: ${paste_info.max_access_n ?? '-'}
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
          ${
            need_qr
              ? `<img src="${paste_info.link_qr}"
            alt="${paste_info.link}" style="max-width: 280px">`
              : ''
          } 
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
    const res = await Config.env().QRCODE.fetch(
      'https://qrcode.nekoid.cc?' +
        new URLSearchParams({
          q: paste_info.link,
          type: 'utf8',
        })
    );

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
export function check_password_rules(password: string): boolean {
  return password.match('^[A-z0-9]{1,}$') !== null;
}
// Extract username and password from Basic Authorization header
export function get_auth(request: ERequest, auth_name: string = 'x-auth-key'): string | null {
  const { headers, query } = request;
  // Retrieve from query params
  const pass = query[auth_name];
  if (typeof pass == 'string' && pass.length > 0) {
    return pass;
  }
  // Retrieve from a specified header
  if (headers.has(auth_name)) {
    return headers.get(auth_name);
  }
  // Retrieve from Authorization header
  if (headers.has('Authorization')) {
    const auth = headers.get('Authorization');
    const [scheme, encoded] = auth!.split(' ');
    // Validate authorization header format
    if (!encoded) {
      return null;
    }
    if (scheme == 'Basic') {
      // Decode base64 to string (UTF-8)
      const buffer = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
      const decoded = new TextDecoder().decode(buffer).normalize();
      const index = decoded.indexOf(':');

      // Check if user & password are split by the first colon and MUST NOT contain control characters.
      if (index === -1 || decoded.match('[\\0-\x1F\x7F]')) {
        return null;
      }
      // Only return password componment
      return decoded.slice(index + 1);
    } else if (scheme == 'Bearer') {
      if (encoded.length > 0) return encoded;
      else null;
    }
  }

  return null;
}

export function to_human_readable_size(bytes: number): string {
  let size = bytes + ' bytes';
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  for (let i = 0, approx = bytes / 1024; approx > 1; approx /= 1024, i++) {
    size = approx.toFixed(3) + ' ' + units[i];
  }
  return size;
}

export function hexToBase64(hex: string): string | null {
  // Ensure the input is a valid 64-digit hex string
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    return null;
  }
  let binaryArray = [];
  for (let i = 0; i < hex.length; i += 2) {
    binaryArray.push(parseInt(hex.slice(i, i + 2), 16));
  }
  const binaryString = String.fromCharCode(...binaryArray);
  return btoa(binaryString);
}

export async function get_presign_url(uuid: string, descriptor: PasteIndexEntry) {
  // Use cached presigned url if expiration is more than 10 mins
  if (descriptor.cached_presigned_url) {
    const expiration = new Date(descriptor.cached_presigned_url_expiration ?? 0);
    const time_to_renew = new Date(Date.now() + 600 * 1000); // 10 mins after
    if (expiration >= time_to_renew) {
      return descriptor.cached_presigned_url;
    }
  }

  const location = descriptor.location ?? (descriptor.paste_type == PasteType.large_paste ? 'large' : 'default');
  const config = Config.get();
  const storage = config.filter_storage(location);
  if (!storage) {
    return null;
  }

  const download_url = storage.download_endpoint ?? storage.endpoint;

  // Generate Presigned Request
  const s3 = new S3Client({
    region: storage.region,
    endpoint: download_url,
    credentials: {
      accessKeyId: storage.access_key_id,
      secretAccessKey: storage.secret_access_key,
    },
    forcePathStyle: true,
  });

  const signed = await getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: storage.bucket_name,
      Key: uuid,
      ResponseContentDisposition: `inline; filename*=UTF-8''${encodeURIComponent(descriptor.title ?? uuid)}`,
      ResponseContentType: descriptor.mime_type ?? 'text/plain; charset=UTF-8;',
    }),
    {
      expiresIn: 1800,
    }
  );

  descriptor.cached_presigned_url = signed;
  descriptor.cached_presigned_url_expiration = new Date(Date.now() + 1800 * 1000).getTime();

  return signed;
}
