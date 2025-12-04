import { Router } from 'itty-router';
import { sha256 } from 'js-sha256';
import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { ERequest, Env } from '../types';
import { gen_id, get_auth, get_paste_info_obj, get_presign_url, hexToBase64, to_human_readable_size } from '../utils';
import { PasteIndexEntry, PasteType } from '../v2/schema';
import Config from '../config';

export const router = Router<ERequest, [Env, ExecutionContext]>({ base: '/api/large_upload' });

router.all('*', (request, env, ctx) => {
  const storage = Config.get().filter_storage('large');
  if (!storage) {
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

  // Content-Type: multipart/form-data
  if (content_type?.includes('multipart/form-data')) {
    const formdata = await request.formData();
    const title = formdata.get('title');
    const mime = formdata.get('mime-type');
    if (typeof title === 'string') file_title = title;
    if (typeof mime === 'string') file_mime = mime;
    const pass = formdata.get('auth-key') || get_auth(request) || undefined;
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
      return new Response('Invalid file-sha256-hash, expecting a 64 digit SHA256 hash hex.\n', {
        status: 422,
      });
    }
  } else {
    return new Response('Currently only support multipart/form-data.\n', {
      status: 501,
    });
  }

  const storage = Config.get().filter_storage('large');
  if (!storage) {
    return new Response('Invalid service config\n', {
      status: 500,
    });
  }

  if (file_size > storage.max_file_size) {
    return new Response(`Paste size must be under ${to_human_readable_size(storage.max_file_size)}.\n`, {
      status: 422,
    });
  }

  const uuid = gen_id();

  const s3 = new S3Client({
    region: storage.region,
    endpoint: storage.upload_endpoint ?? storage.endpoint,
    credentials: {
      accessKeyId: storage.access_key_id,
      secretAccessKey: storage.secret_access_key,
    },
    forcePathStyle: true,
  });

  const current = Date.now();
  const expiration = new Date(current + 14400 * 1000).getTime();
  const encoded_hash = hexToBase64(file_hash);
  if (!encoded_hash) {
    return new Response('Invalid SHA256 hex.\n', {
      status: 400,
    });
  }
  const required_headers = {
    'Content-Length': file_size.toString(),
    'x-amz-checksum-sha256': encoded_hash,
  };

  // Generate Presigned Request
  const signed_url = await getSignedUrl(
    s3,
    new PutObjectCommand({
      Bucket: storage.bucket_name,
      Key: uuid,
      ChecksumSHA256: encoded_hash,
      ChecksumAlgorithm: 'SHA256',
      ContentType: file_size.toString(),
    }),
    {
      expiresIn: 900,
      unhoistableHeaders: new Set(['x-amz-checksum-sha256']),
    }
  );

  const result = {
    uuid,
    expiration,
    file_size,
    file_hash,
    // signed_url: signed.url,
    signed_url,
    required_headers,
  };

  const descriptor: PasteIndexEntry = {
    uuid,
    title: file_title || undefined,
    mime_type: file_mime || undefined,
    created_at: current,
    expired_at: new Date(Date.now() + 900 * 1000).getTime(),
    password: password ? sha256(password).slice(0, 16) : undefined,
    access_n: 0,
    max_access_n: read_limit ?? undefined,
    paste_type: PasteType.large_paste,
    file_size: file_size,
    upload_track: {
      pending_upload: true,
    },
  };

  ctx.waitUntil(
    env.PASTE_INDEX.put(uuid, JSON.stringify(descriptor), {
      expirationTtl: 14400,
    })
  );

  return new Response(JSON.stringify(result));
});

router.post('/complete/:uuid', async (request, env, ctx) => {
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
  if (descriptor.paste_type !== PasteType.large_paste || !descriptor.upload_track?.pending_upload) {
    return new Response('Invalid operation.\n', {
      status: 442,
    });
  }

  const storage = config.filter_storage('large');

  const s3 = new S3Client({
    region: storage!.region,
    endpoint: storage!.endpoint,
    credentials: {
      accessKeyId: storage!.access_key_id,
      secretAccessKey: storage!.secret_access_key,
    },
    forcePathStyle: true,
  });

  try {
    // Get object attributes
    const objectmeta = await s3.send(
      new HeadObjectCommand({
        Bucket: storage!.bucket_name,
        Key: uuid,
      })
    );
    if (objectmeta.$metadata.httpStatusCode === 200) {
      const file_size = objectmeta.ContentLength;
      if (file_size !== descriptor.file_size) {
        return new Response(`This paste is not finishing upload. (${file_size} != ${descriptor.file_size})\n`, {
          status: 400,
        });
      }
    } else {
      return new Response('This paste is not finishing upload.\n', {
        status: 400,
      });
    }
  } catch (err) {
    return new Response('Internal server error.\n', {
      status: 500,
    });
  }

  const current = Date.now();
  const expriation = new Date(Date.now() + 2419200 * 1000).getTime(); // default 28 days
  // Remove unneeded propty
  delete descriptor.upload_track;
  descriptor.created_at = current;
  descriptor.expired_at = expriation;
  ctx.waitUntil(env.PASTE_INDEX.put(uuid, JSON.stringify(descriptor), { expirationTtl: 2419200 }));

  const paste_info = {
    upload_completed: true,
    expired: new Date(expriation).toISOString(),
    paste_info: get_paste_info_obj(uuid, descriptor),
  };

  return new Response(JSON.stringify(paste_info));
});

router.get('/:uuid', async (request, env, ctx) => {
  const { uuid } = request.params;
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

  // Check password if needed
  if (descriptor.password !== undefined) {
    let cert = get_auth(request);
    if (cert == null) {
      return new Response('This paste requires password.\n', {
        status: 403,
      });
    } else if (descriptor.password !== sha256(cert).slice(0, 16)) {
      return new Response('Incorrect password.\n', {
        status: 403,
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

  if (descriptor.paste_type == PasteType.large_paste) {
    return new Response('Invalid operation.\n', {
      status: 400,
    });
  }

  if (!descriptor.upload_track?.pending_upload) {
    return new Response('This paste is not yet finalized.\n', {
      status: 400,
    });
  }

  const signed_url = await get_presign_url(uuid, descriptor);
  const result = {
    uuid,
    expire: new Date(descriptor.expired_at).toISOString(),
    signed_url,
  };

  return new Response(JSON.stringify(result));
});
