import { IRequest } from 'itty-router';

export type ERequest = {
  is_browser: boolean;
  origin?: string;
  // match_etag?: string;
} & IRequest;

export type PASTE_TYPES = 'paste' | 'text' | 'link' | 'large_paste';

// Deprecated
export interface PasteIndexEntry {
  title?: string;
  mime_type?: string;
  last_modified: number;
  expiration?: number; // New added in 2.0
  file_size: number;
  password?: string;
  editable?: boolean; // Default: False (unsupported)
  access_n: number;
  max_access_n?: number;
  type: PASTE_TYPES;
  // Only apply when large_paste
  upload_completed?: boolean;
  cached_presigned_url?: string;
  cached_presigned_url_expiration?: number;
}

export interface Env {
  // Variable
  SERVICE_URL: string;
  PASTE_WEB_URL?: string;
  UUID_LENGTH: string;
  CORS_DOMAIN?: string;
  // Secret
  PASTE_INDEX: KVNamespace;
  QRCODE: ServiceWorkerGlobalScope;
  AWS_ACCESS_KEY_ID: string;
  AWS_SECRET_ACCESS_KEY: string;
  LARGE_AWS_ACCESS_KEY_ID?: string;
  LARGE_AWS_SECRET_ACCESS_KEY?: string;
  ENDPOINT: string;
  LARGE_ENDPOINT?: string;
  LARGE_DOWNLOAD_ENDPOINT?: string;
}

export interface Config extends Env {
  UUID_LENGTH: number;
  enable_large_upload: boolean;
}