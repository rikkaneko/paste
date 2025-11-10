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
  CONFIG_NAME?: string;
  PASTE_INDEX: KVNamespace;
  QRCODE: ServiceWorkerGlobalScope;
}