import { IRequest } from 'itty-router';

export type ERequest = {
  is_browser: boolean;
  origin?: string;
  // match_etag?: string;
} & IRequest;

export type PASTE_TYPES = 'paste' | 'text' | 'link' | 'large_paste';

export interface PasteIndexEntry {
  title?: string;
  mime_type?: string;
  last_modified: number;
  expiration?: number; // New added in 2.0
  size: number;
  password?: string;
  editable?: boolean; // Default: False (unsupported)
  read_count_remain?: number;
  type: PASTE_TYPES;
  // Only apply when large_paste
  upload_completed?: boolean;
  cached_presigned_url?: string;
  cached_presigned_url_expiration?: number;
}

export interface Env {
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

export interface PasteInit {
  content: File | string; // field u
  title?: string; // field title
  mime?: string; // field mime
  paste_type?: PASTE_TYPES; // field paste_type (Default: paste)
  pass?: string; // field pass
  read_limit?: number; // field number
}