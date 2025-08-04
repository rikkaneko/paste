import { Router } from 'itty-router/Router';
import { Env, ERequest } from '../types';
import constants from '../constant';
import {
  PasteAPIRepsonse,
  PasteCreateParams,
  PasteCreateParamsValidator,
  PasteInfo,
  PasteIndexEntry,
  PasteCreateUploadResponse,
  PasteType,
  PasteInfoUpdateParams,
  PasteInfoUpdateParamsValidator,
} from './schema';
import { gen_id, get_auth } from '../utils';
import { AwsClient } from 'aws4fetch';
import { sha256 } from 'js-sha256';
import { xml2js } from 'xml-js';

/* RESTful API (v2) */
export const router = Router<ERequest, [Env, ExecutionContext]>({ base: '/v2' });

/* GET /info/:uuid
 *
 * Response:
 * <PasteInfo> | <Error>
 */
router.get('/info/:uuid', async (req, env, ctx) => {
  const { uuid } = req.params;
  if (uuid.length !== constants.UUID_LENGTH) {
    new PasteAPIRepsonse();
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
  if (uuid.length !== constants.UUID_LENGTH) {
    new PasteAPIRepsonse();
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
    let cert = get_auth(headers, 'Bearer');
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
  if (params.file_size > 262144000) {
    return PasteAPIRepsonse.build(422, 'Paste size must be under 250MB.\n');
  }

  const uuid = gen_id();

  const s3 = new AwsClient({
    accessKeyId: env.LARGE_AWS_ACCESS_KEY_ID!,
    secretAccessKey: env.LARGE_AWS_SECRET_ACCESS_KEY!,
    service: 's3', // required
  });

  const current_time = Date.now();
  // Temporary expiration time
  const expiration = new Date(current_time + 900 * 1000).getTime();
  const upload_path = new URL(`${env.LARGE_ENDPOINT}/${uuid}`);
  upload_path.searchParams.set('X-Amz-Expires', '900'); // Valid for 15 mins
  const request_headers = {
    'Content-Length': params.file_size.toString(),
    'X-Amz-Content-Sha256': params.file_hash,
  };

  // Generate Presigned Request
  const signed = await s3.sign(upload_path, {
    method: 'PUT',
    headers: request_headers,
    aws: {
      signQuery: true,
      service: 's3',
      allHeaders: true,
    },
  });

  const result: PasteCreateUploadResponse = {
    uuid,
    expiration,
    upload_url: signed.url,
    request_headers,
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
  if (uuid.length !== constants.UUID_LENGTH) {
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

  const s3 = new AwsClient({
    accessKeyId: env.LARGE_AWS_ACCESS_KEY_ID!,
    secretAccessKey: env.LARGE_AWS_SECRET_ACCESS_KEY!,
    service: 's3', // required
  });

  try {
    // Get object attributes
    const objectmeta = await s3.fetch(`${env.LARGE_ENDPOINT}/${uuid}?attributes`, {
      method: 'GET',
      headers: {
        'X-AMZ-Object-Attributes': 'ObjectSize',
      },
    });
    if (objectmeta.ok) {
      const xml = await objectmeta.text();
      const parsed: any = xml2js(xml, {
        compact: true,
        nativeType: true,
        alwaysArray: false,
        elementNameFn: (val) => val.toLowerCase(),
      });
      const file_size: number = parsed.getobjectattributesresponse.objectsize._text;
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

/* DELETE /:uuid
 * Header: Authorization: Basic <password>
 *
 * Response:
 * <empty> | <Error>
 */
router.delete('/:uuid', async (req, env, ctx) => {
  const { uuid } = req.params;
  if (uuid.length !== constants.UUID_LENGTH) {
    new PasteAPIRepsonse();
    return PasteAPIRepsonse.build(442, 'Invalid UUID.');
  }

  // Delete paste logic
  const val = await env.PASTE_INDEX.get(uuid);
  if (val === null) {
    return PasteAPIRepsonse.build(404, 'Paste not found.');
  }

  // TODO Delete paste logic
  return PasteAPIRepsonse.build(200, 'This endpoint is not ready.');
});

/* POST /upload/:uuid?code=<authorization-code>
 * Body: <file-content>
 *
 * Response:
 * <PasteCreateUploadResponse> | <Error>
 */
router.post('/upload', async (req, env, ctx) => {
  // TODO Upload paste logic
  return PasteAPIRepsonse.build(200, 'This endpoint is not ready.');
});

// Fallback route
router.all('*', async () => {
  return PasteAPIRepsonse.build(403, 'Invalid endpoint.');
});

export default router;
