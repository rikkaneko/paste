export interface PasteIndexEntry {
  title?: string;
  mime_type?: string;
  last_modified: number;
  size: number;
  password?: string;
  editable?: boolean; // Default: False (unsupported)
  read_count_remain?: number;
  type?: string;
}
