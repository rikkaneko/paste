import { Validator, Rule } from '@cesium133/forgjs';

export enum PasteType {
  paste = 1,
  link = 2,
  large_paste = 3,
  unknown = 4,
}

export const PasteTypeStr = (p: PasteType): string | undefined => {
  if (p <= 0 || p >= 4) return 'unknown';
  return ['paste', 'link', 'large_paste'].at(p - 1);
};

export const PasteTypeFrom = (s: string): PasteType => {
  switch (s) {
    case 'paste':
      return PasteType.paste;
    case 'link':
      return PasteType.link;
    case 'large_paste':
      return PasteType.large_paste;
    default:
      return PasteType.unknown;
  }
};

export interface PasteInfo {
  uuid: string;
  paste_type: PasteType;
  title?: string;
  file_size: number;
  mime_type?: string;
  has_password: boolean;
  access_n: number;
  max_access_n?: number;
  created_at: number;
  expired_at: number;
}

// PasteIndexEntry v2
export interface PasteIndexEntry {
  uuid: string;
  paste_type: PasteType;
  title?: string;
  file_size: number;
  mime_type?: string;
  password?: string;
  created_at: number;
  expired_at: number;
  access_n: number;
  max_access_n?: number;
  // Track upload status
  upload_track?: {
    pending_upload?: boolean;
    saved_expired_at?: number;
  };
  // Only available when large_paste or using /v2/create
  cached_presigned_url?: string;
  cached_presigned_url_expiration?: number;
}

export interface PasteCreateParams {
  password?: string;
  max_access_n?: number;
  title?: string;
  mime_type?: string;
  file_size: number;
  file_hash: string;
  expired_at?: number;
}

const param_rules = {
  password: new Rule({ type: 'password', optional: true, notEmpty: true, maxLength: 40 }),
  max_access_n: new Rule({ type: 'int', optional: true, min: 1 }),
  title: new Rule({ type: 'string', optional: true, notEmpty: true }),
  mime_type: new Rule({ type: 'string', optional: true, notEmpty: true }),
  file_size: new Rule({ type: 'int', min: 0 }),
  file_hash: new Rule({ type: 'string', minLength: 64, maxLength: 64 }),
  expired_at: new Rule({
    type: 'int',
    optional: true,
    min: Date.now(),
    max: new Date(Date.now() + 2419200 * 1000).getTime(), // max. 28 days
  }),
};

export const PasteCreateParamsValidator = new Validator(param_rules);

export interface PasteCreateUploadResponse {
  uuid: string;
  expiration: number;
  upload_url: string;
  request_headers: {
    'Content-Length': string;
    'X-Amz-Content-Sha256': string;
  };
}

export interface PasteInfoUpdateParams {
  password?: string;
  max_access_n?: number;
  title?: string;
  mime_type?: string;
  expired_at?: number;
}

// Omit non-editable fields
const { file_size, file_hash, ...editabe_fiels } = param_rules;

export const PasteInfoUpdateParamsValidator = new Validator(editabe_fiels);

export class PasteAPIRepsonse {
  static build(
    status_code: number = 200,
    content?: string | PasteInfo | PasteCreateUploadResponse,
    headers?: HeadersInit,
    content_name?: string
  ): Response {
    // Default content name if not set
    if (content_name == undefined) {
      if (typeof content == 'string') {
        content_name = 'message';
      } else if (typeof content == 'object' && content.constructor?.name !== 'Object') {
        content_name = content.constructor.name;
      } else content_name = 'content';
    }

    return new Response(
      JSON.stringify({
        status_code,
        [content_name]: content,
      }) + '\n',
      {
        status: status_code,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          ...headers,
        },
      }
    );
  }

  static info(descriptor: PasteIndexEntry) {
    const paste_info: PasteInfo = {
      uuid: descriptor.uuid,
      title: descriptor.title,
      paste_type: descriptor.paste_type,
      file_size: descriptor.file_size,
      mime_type: descriptor.mime_type,
      has_password: descriptor.password !== undefined,
      access_n: descriptor.access_n,
      max_access_n: descriptor.max_access_n,
      created_at: descriptor.created_at,
      expired_at: descriptor.expired_at,
    };
    return this.build(200, paste_info, undefined, 'PasteInfo');
  }
}
