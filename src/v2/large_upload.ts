import { Router } from 'itty-router';
import { sha256 } from 'js-sha256';
import { AwsClient } from 'aws4fetch';
import { ERequest, Env, PasteIndexEntry } from '../types';
import { gen_id } from '../utils';
import { UUID_LENGTH } from '../constant';

export const router = Router<ERequest, [Env, ExecutionContext]>({ base: '/v2/large_upload' });

export async function get_presign_url(uuid: string, descriptor: PasteIndexEntry, env: Env) {
  const endpoint_url = new URL(`${env.LARGE_DOWNLOAD_ENDPOINT}/${uuid}`);
  endpoint_url.searchParams.set('X-Amz-Expires', '3600');
  endpoint_url.searchParams.set(
    'response-content-disposition',
    `inline; filename*=UTF-8''${encodeURIComponent(descriptor.title ?? uuid)}`
  );
  endpoint_url.searchParams.set('response-content-type', descriptor.mime_type ?? 'text/plain; charset=UTF-8;');

  // Generate Presigned Request
  const s3 = new AwsClient({
    accessKeyId: env.LARGE_AWS_ACCESS_KEY_ID!,
    secretAccessKey: env.LARGE_AWS_SECRET_ACCESS_KEY!,
    service: 's3',
  });

  const signed = await s3.sign(endpoint_url, {
    method: 'GET',
    headers: {},
    aws: {
      signQuery: true,
    },
  });

  return signed.url;
}

router.all('*', (request, env, ctx) => {
  if (!env.LARGE_AWS_ACCESS_KEY_ID || !env.LARGE_AWS_SECRET_ACCESS_KEY || !env.LARGE_ENDPOINT) {
    return new Response('This function is currently disabled.\n', {
      status: 501,
    });
  }
});

router.post('/create', async (request, env, ctx) => {
  const { headers } = request;
  const content_type = headers.get('content-type');

  let file_title: string | undefined;
  let file_mime: string | undefined;
  let password: string | undefined;
  let read_limit: number | undefined;
  let file_size: number | undefined;
  let file_hash: string | undefined;
  if (content_type?.includes('multipart/form-data')) {
    const formdata = await request.formData();
    const title = formdata.get('title');
    const mime = formdata.get('mime-type');
    if (typeof title === 'string') file_title = title;
    if (typeof mime === 'string') file_mime = mime;
    const pass = formdata.get('pass') ?? undefined;
    if (typeof pass === 'string') password = pass;

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

    const size = formdata.get('file-size');
    if (typeof size === 'string') {
      const n = parseInt(size);
      if (isNaN(n) || n <= 0) {
        return new Response('Invalid file-size, expecting a positive integer.\n', {
          status: 422,
        });
      }
      file_size = n;
    } else {
      return new Response('Invalid file-size, expecting a positive integer.\n', {
        status: 422,
      });
    }

    file_hash = formdata.get('file-sha256-hash') ?? undefined;
    if (!file_hash || file_hash.length !== 64) {
      return new Response('Invalid file-sha256-hash, expecting a SHA256 hex.\n', {
        status: 422,
      });
    }
  } else {
    return new Response('Currently only support multipart/form-data.\n', {
      status: 501,
    });
  }

  if (file_size > 262144000) {
    return new Response('Paste size must be under 250MB.\n', {
      status: 422,
    });
  }

  const uuid = gen_id();

  const s3 = new AwsClient({
    accessKeyId: env.LARGE_AWS_ACCESS_KEY_ID!,
    secretAccessKey: env.LARGE_AWS_SECRET_ACCESS_KEY!,
    service: 's3',
  });

  const current = Date.now();
  const expiration = new Date(current + 14400 * 1000).getTime();
  const endpoint_url = new URL(`${env.LARGE_ENDPOINT}/${uuid}`);
  endpoint_url.searchParams.set('X-Amz-Expires', '14400');
  const required_headers = {
    'Content-Length': file_size.toString(),
    'X-Amz-Content-Sha256': file_hash,
  };

  // Generate Presigned Request
  const signed = await s3.sign(endpoint_url, {
    method: 'PUT',
    headers: required_headers,
    aws: {
      signQuery: true,
      service: 's3',
      allHeaders: true,
    },
  });

  const result = {
    uuid,
    expiration,
    file_size,
    file_hash,
    signed_url: signed.url,
    required_headers,
  };

  const descriptor: PasteIndexEntry = {
    title: file_title || undefined,
    mime_type: file_mime || undefined,
    last_modified: current,
    expiration: new Date(Date.now() + 3600 * 1000).getTime(),
    password: password ? sha256(password).slice(0, 16) : undefined,
    read_count_remain: read_limit ?? undefined,
    type: 'large_paste',
    size: file_size,
    upload_completed: false,
    sha256_hash: file_hash,
  };

  ctx.waitUntil(
    env.PASTE_INDEX.put(uuid, JSON.stringify(descriptor), {
      expirationTtl: 14400,
    })
  );

  return new Response(JSON.stringify(result));
});

router.post('/complete/:uuid', async (request, env, ctx) => {
  const { headers } = request;
  const { uuid } = request.params;
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
  if (descriptor.type !== 'large_paste' || descriptor.upload_completed) {
    return new Response('Invalid operation.\n', {
      status: 442,
    });
  }

  const s3 = new AwsClient({
    accessKeyId: env.LARGE_AWS_ACCESS_KEY_ID!,
    secretAccessKey: env.LARGE_AWS_SECRET_ACCESS_KEY!,
    service: 's3',
  });

  try {
    const objectmeta = await s3.fetch(`${env.LARGE_ENDPOINT}/${uuid}`, {
      method: 'HEAD',
    });
    if (objectmeta.ok) {
      const { headers } = objectmeta;
      const file_size = headers.get('Content-Length') || '0';
      if (parseInt(file_size) !== descriptor.size) {
        return new Response('This paste is not finishing the upload.\n', {
          status: 400,
        });
      }
    } else {
      return new Response('This paste is not finishing the upload.\n', {
        status: 400,
      });
    }
  } catch (err) {
    return new Response('Unable to connect to remote.\n', {
      status: 500,
    });
  }

  const current = Date.now();
  const expriation = new Date(Date.now() + 2419200 * 1000).getTime(); // default 28 days
  descriptor.upload_completed = true;
  descriptor.last_modified = current;
  descriptor.expiration = expriation;
  ctx.waitUntil(env.PASTE_INDEX.put(uuid, JSON.stringify(descriptor), { expirationTtl: 2419200 }));

  const paste_info = {
    uuid,
    upload_completed: true,
    expired: new Date(expriation).toISOString(),
  };

  return new Response(JSON.stringify(paste_info), {
    status: 400,
  });
});

router.get('/:uuid', async (request, env, ctx) => {
  const { uuid } = request.params;
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
  if (descriptor.type !== 'large_paste') {
    return new Response('Invalid operation.\n', {
      status: 400,
    });
  }

  if (!descriptor.upload_completed) {
    return new Response('This paste is not yet finalized.\n', {
      status: 400,
    });
  }

  const signed_url = await get_presign_url(uuid, descriptor, env);
  const result = {
    uuid,
    expire: new Date(descriptor.expiration || 0).toISOString(),
    signed_url,
  };

  return new Response(JSON.stringify(result));
});