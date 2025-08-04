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
import constants from './constant';
import { Env } from './types';
import { PasteIndexEntry, PasteTypeStr } from './v2/schema';

export const gen_id = customAlphabet(
  '1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',
  constants.UUID_LENGTH
);

// Paste API Response (v1)
export function get_paste_info_obj(uuid: string, descriptor: PasteIndexEntry, env: Env) {
  const created = new Date(descriptor.created_at);
  const expired = new Date(descriptor.expired_at);
  const link = `${env.SERVICE_URL}/${uuid}`;
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
  env: Env,
  use_html: boolean = true,
  need_qr: boolean = false,
  reply_json = false
): Promise<Response> {
  const paste_info = get_paste_info_obj(uuid, descriptor, env);

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
    const res = await env.QRCODE.fetch(
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
export function get_auth(headers: Headers, required_scheme: string): string | [string, string] | null {
  if (headers.has('Authorization')) {
    const auth = headers.get('Authorization');
    const [scheme, encoded] = auth!.split(' ');
    // Validate authorization header format
    if (!encoded || scheme !== required_scheme) {
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

      return [decoded.slice(0, index), decoded.slice(index + 1)];
    } else if (scheme == 'Bearer') {
      if (encoded.length > 0) return encoded;
      else null;
    }
  }
  return null;
}

function to_human_readable_size(bytes: number): string {
  let size = bytes + ' bytes';
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  for (let i = 0, approx = bytes / 1024; approx > 1; approx /= 1024, i++) {
    size = approx.toFixed(3) + ' ' + units[i];
  }
  return size;
}
