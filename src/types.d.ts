import { IRequest } from 'itty-router';

export type ERequest = {
  is_browser: boolean;
  // match_etag?: string;
} & IRequest;

export interface PasteIndexEntry {
  title?: string;
  mime_type?: string;
  last_modified: number;
  size: number;
  password?: string;
  editable?: boolean; // Default: False (unsupported)
  read_count_remain?: number;
  type?: string;
  upload_completed?: boolean;
  sha256_hash?: string;
}

export interface Env {
  PASTE_INDEX: KVNamespace;
  QRCODE: ServiceWorkerGlobalScope;
  AWS_ACCESS_KEY_ID: string;
  AWS_SECRET_ACCESS_KEY: string;
  LARGE_AWS_ACCESS_KEY_ID?: string;
  LARGE_AWS_SECRET_ACCESS_KEY?: string;
  ENDPOINT: string;
  LARGE_ENDPOINT: string;
}