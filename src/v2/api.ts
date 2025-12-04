import { Router } from 'itty-router/Router';
import { Env, ERequest } from '../types';
import {
  PasteAPIRepsonse,
  PasteCreateParams,
  PasteCreateParamsValidator,
  PasteIndexEntry,
  PasteCreateUploadResponse,
  PasteType,
  PasteInfoUpdateParams,
  PasteInfoUpdateParamsValidator,
  ConfigParams,
  ConfigParamsValidator,
} from './schema';
import { gen_id, get_auth } from '../utils';
import { sha256 } from 'js-sha256';
import { HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import Config from '../config';

/* RESTful API (v2) */
export const router = Router<ERequest, [Env, ExecutionContext]>({ base: '/v2' });

/* GET /info/:uuid
 *
 * Response:
 * <PasteInfo> | <Error>
 */
router.get('/info/:uuid', async (req, env, ctx) => {
  const { uuid } = req.params;
  const config = Config.get().config();
  if (uuid.length !== config.uuid_length) {
    return PasteAPIRepsonse.build(442, 'Invalid UUID.');
  }
  const val = await env.PASTE_INDEX.get(uuid);
  if (val === null) {
    return PasteAPIRepsonse.build(404, 'Paste not found.');
  }
  const descriptor: PasteIndexEntry = JSON.parse(val);
  return PasteAPIRepsonse.info(descriptor);
});

/* POST /info/:uuid
 * Header: Authorization: Basic <password>
 *
 * Response:
 * <empty> | <Error>
 */
router.post('/info/:uuid', async (req, env, ctx) => {
  const { uuid } = req.params;
  const config = Config.get().config();
  if (uuid.length !== config.uuid_length) {
    return PasteAPIRepsonse.build(442, 'Invalid UUID.');
  }
  const val = await env.PASTE_INDEX.get(uuid);
  if (val === null) {
    return PasteAPIRepsonse.build(404, 'Paste not found.');
  }
  const descriptor: PasteIndexEntry = JSON.parse(val);

  let params: PasteInfoUpdateParams | undefined;
  try {
    const _params: PasteInfoUpdateParams = await req.json();
    if (!PasteInfoUpdateParamsValidator.test(_params)) {
      return PasteAPIRepsonse.build(400, 'Invalid request fields.');
    }
    params = _params;
  } catch (e) {
    return PasteAPIRepsonse.build(400, 'Invalid request.');
  }

  // Check password if needed
  if (descriptor.password !== undefined) {
    const { headers } = req;
    let cert = get_auth(req);
    // Error occurred when parsing the header
    if (cert === null) {
      return PasteAPIRepsonse.build(
        403,
        'This paste is password-protected. You must provide the current access credentials to update its metadata.'
      );
    }
    // Check password and username should be empty
    if (descriptor.password !== sha256(cert as string).slice(0, 16)) {
      return PasteAPIRepsonse.build(403, 'Invalid access credentials.');
    }
  }

  if (descriptor.upload_track?.pending_upload) {
    return PasteAPIRepsonse.build(400, 'This paste is not yet finalized.');
  }

  // Change paste info logic
  // Explict assign the fields
  const update: PasteInfoUpdateParams = {
    password: params.password ? sha256(params.password).slice(0, 16) : undefined,
    max_access_n: params.max_access_n,
    title: params.title,
    mime_type: params.mime_type,
    expired_at: params.expired_at,
  };

  // Remove redundant fields
  Object.keys(update).forEach(
    (key) =>
      update[key as keyof PasteInfoUpdateParams] === undefined && delete update[key as keyof PasteInfoUpdateParams]
  );

  const updated_descriptor: PasteIndexEntry = {
    ...descriptor,
    ...update,
  };

  ctx.waitUntil(env.PASTE_INDEX.put(uuid, JSON.stringify(updated_descriptor), { expirationTtl: 2419200 }));
  return PasteAPIRepsonse.info(updated_descriptor);
});

/* POST /create
 * Body: <PasteCreateLargeParams>
 *
 * Response:
 * <PasteCreateUploadResponse> | <Error>
 */
router.post('/create', async (req, env, ctx) => {
  let params: PasteCreateParams | undefined;
  const storage = Config.get().filter_storage('large');
  if (!storage) {
    return PasteAPIRepsonse.build(501, 'This endpoint is disabled.');
  }
  try {
    const _params: PasteCreateParams = await req.json();
    if (!PasteCreateParamsValidator.test(_params)) {
      return PasteAPIRepsonse.build(400, 'Invalid request fields.');
    }
    params = _params;
  } catch (e) {
    return PasteAPIRepsonse.build(400, 'Invalid request.');
  }

  // Create paste logic
  if (params.file_size > storage.max_file_size) {
    return PasteAPIRepsonse.build(422, `Paste size must be under ${to_human_readable_size(storage.max_file_size)}\n`);
  }

  const uuid = gen_id();

  const s3 = new S3Client({
    region: storage.region,
    endpoint: storage.endpoint,
    credentials: {
      accessKeyId: storage.access_key_id,
      secretAccessKey: storage.secret_access_key,
    },
    forcePathStyle: true,
  });

  const current_time = Date.now();
  // Temporary expiration time
  const expiration = new Date(current_time + 900 * 1000).getTime();
  const required_headers = {
    'Content-Length': params.file_size.toString(),
    'x-amz-checksum-sha256': params.file_hash,
  };

  // Generate Presigned Request
  const signed_url = await getSignedUrl(
    s3,
    new PutObjectCommand({
      Bucket: storage.bucket_name,
      Key: uuid,
      ChecksumSHA256: params.file_hash,
      ChecksumAlgorithm: 'SHA256',
      ContentType: params.file_size.toString(),
    }),
    {
      expiresIn: 900,
      unhoistableHeaders: new Set(['x-amz-checksum-sha256']),
    }
  );

  const result: PasteCreateUploadResponse = {
    uuid,
    expiration,
    upload_url: signed_url,
    request_headers: required_headers,
  };

  const descriptor: PasteIndexEntry = {
    uuid,
    title: params.title || undefined,
    mime_type: params.mime_type || undefined,
    password: params.password ? sha256(params.password).slice(0, 16) : undefined,
    access_n: 0,
    max_access_n: params.max_access_n,
    paste_type: PasteType.large_paste,
    file_size: params.file_size,
    created_at: current_time,
    expired_at: expiration,
    upload_track: {
      pending_upload: true,
      saved_expired_at: params.expired_at,
    },
  };

  ctx.waitUntil(
    env.PASTE_INDEX.put(uuid, JSON.stringify(descriptor), {
      expirationTtl: 14400,
    })
  );

  return new Response(JSON.stringify(result));
});

/* POST /complete/:uuid
 *
 * Response:
 * <empty> | <PasteAPIError>
 */
router.post('/complete/:uuid', async (req, env, ctx) => {
  const { uuid } = req.params;
  const config = Config.get().config();
  const storage = Config.get().filter_storage('large');
  if (!storage) {
    return PasteAPIRepsonse.build(501, 'This endpoint is disabled.');
  }
  if (uuid.length !== config.uuid_length) {
    new PasteAPIRepsonse();
    return PasteAPIRepsonse.build(442, 'Invalid UUID.');
  }

  // Complete uploaded paste logic
  const val = await env.PASTE_INDEX.get(uuid);
  if (val === null) {
    return PasteAPIRepsonse.build(404, 'Paste not found.');
  }

  const descriptor: PasteIndexEntry = JSON.parse(val);
  if (descriptor.paste_type !== PasteType.large_paste || !descriptor.upload_track?.pending_upload) {
    return PasteAPIRepsonse.build(442, 'Invalid operation.');
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

  try {
    // Get object attributes
    const objectmeta = await s3.send(
      new HeadObjectCommand({
        Bucket: storage.bucket_name,
        Key: uuid,
      })
    );
    if (objectmeta.$metadata.httpStatusCode === 200) {
      const file_size = objectmeta.ContentLength;
      if (file_size !== descriptor.file_size) {
        return PasteAPIRepsonse.build(
          400,
          `This paste is not finishing upload. (${file_size} != ${descriptor.file_size})\n`
        );
      }
    } else {
      return PasteAPIRepsonse.build(400, 'Unable to query paste status from remote server.');
    }
  } catch (err) {
    return PasteAPIRepsonse.build(500, 'Internal server error.');
  }

  descriptor.expired_at = descriptor.expired_at =
    descriptor.upload_track?.saved_expired_at ?? new Date(descriptor.created_at + 2419200 * 1000).getTime(); // default 28 days;
  // Remove unneeded propty
  delete descriptor.upload_track;
  ctx.waitUntil(env.PASTE_INDEX.put(uuid, JSON.stringify(descriptor), { expirationTtl: 2419200 }));

  return PasteAPIRepsonse.info(descriptor);
});

router.get('/config', async (req, env, ctx) => {
  const auth = get_auth(req, 'x-auth-token') as string | null;
  if (!auth || !Config.check_auth(auth)) {
    return PasteAPIRepsonse.build(404, 'Invalid endpoint.');
  }
  const config = Config.get().config();
  if (config.storages) {
    // Erase sensitive infomation
    config.storages.map((ent) => {
      ent.access_key_id = '***';
      ent.secret_access_key = '***';
    });
  }
  return PasteAPIRepsonse.build(200, config, 'Config');
});

router.post('/config', async (req, env, ctx) => {
  const auth = get_auth(req, 'x-auth-token') as string | null;
  if (!auth || !Config.check_auth(auth)) {
    return PasteAPIRepsonse.build(404, 'Invalid endpoint.');
  }
  let new_config: ConfigParams | undefined;
  try {
    const _params: ConfigParams = await req.json();
    if (!ConfigParamsValidator.test(_params)) {
      return PasteAPIRepsonse.build(400, 'Invalid config.');
    }
    new_config = _params;
  } catch (e) {
    return PasteAPIRepsonse.build(400, 'Invalid request.');
  }
  const res = await Config.update(new_config, auth);
  if (res) {
    return PasteAPIRepsonse.build(200, 'Config updated.');
  }
  return PasteAPIRepsonse.build(400, 'Unable to update config.');
});

// Fallback route
router.all('*', async () => {
  return PasteAPIRepsonse.build(404, 'Invalid endpoint.');
});

export default router;
function to_human_readable_size(max_file_size: number) {
  throw new Error('Function not implemented.');
}

