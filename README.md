# Paste

This project is a fast, anonymous file and text sharing platform built on a serverless architecture with live instance available at [pb.nekoid.cc](https://pb.nekoid.cc), deployed as a Cloudflare Workers, written in Typescript. Originally designed to quickly share logs, configuration files, and even command output with another computer.

This service enables users to quickly and anonymously share files, texts, and URLs with QR Codes and shortened URLs. 
All the upload files are stored in an object service, which can be any S3-compatible service, like AWS S3. It supports fast file upload
and fetch via RESTful API, web interface and cURL for console, and caching of frequently accessed files with Cloudflare CDN.

The maximum upload file size is limited to **250 MB** and the paste will be kept for **28 days** only by default.  
*All data may be deleted or expired without any notification and guarantee.*  
Please **DO NOT** abuse this service.

## Supported features

- [x] Upload paste
- [x] Download paste
- [x] Delete paste
- [ ] Update existing paste
- [x] Password protection (support [HTTP Basic authentication](https://en.wikipedia.org/wiki/Basic_access_authentication) and `x-auth-key` header)
- [x] Limit access times
- [x] View paste in browsers (only for text and media file)
- [ ] Expiring paste (*not support directly, see [this section](#expiring-paste)*)
- [ ] Render paste code with syntax highlighting
- [x] Generate QR code for paste link
- [x] Support URL redirection using [HTTP status codes 301](https://en.wikipedia.org/wiki/URL_redirection#HTTP_status_codes_3xx)
- [x] Runtime config
- [x] Multiple storage locations

## Service architecture

This project is designed to use a S3-compatible object storage (via [aws4fetch](https://github.com/mhart/aws4fetch)) as the backend storage
and [Cloudflare Worker KV](https://developers.cloudflare.com/workers/runtime-apis/kv) as index.
All requests are handled by [Cloudflare Worker](https://developers.cloudflare.com/workers) with the entry point `fetch()`.  
It is worth noting that Cloudflare Worker is run *before* the cache. Therefore, all requests will not be cached.
[Cache API](https://developers.cloudflare.com/workers/runtime-apis/cache/) is used instead to interact with Cloudflare cache.

## Environment variable

|Variable name|Description|
|-|-|
|`CONFIG_NAME`|Config key name to the runtime config (Default to `config`)|

## Runtime config
Now the runtime config is stored in the Worker KV with the name `config`.  
The actual schema for the runtime config is available at `StorageConfigParams` and `ConfigParams` in [v2/schema.ts](src/v2/schema.ts).

### Runtime config schema
```typescript
export interface StorageConfigParams {
  name: string;
  // S3-compatible service endpoint, must be publicly acccessible from Cloudflare CDN
  endpoint: string;
  // Custom endpoint for downloads
  download_endpoint?: string;
  // Custom endpoint for downloads
  upload_endpoint?: string;
  // Control whether this endpoint can proxy through Cloudflare CDN
  no_proxy_cdn?: boolean;
  // Region (Default to us-east-1 if not specified)
  region?: string;
  // Bucket name
  bucket_name: string;
  // AWS access key ID
  access_key_id: string;
  // Secret key associated with an AWS access key ID
  secret_access_key: string;
  // Maximum acceptable file size for this endpoint
  max_file_size: number;
}

export interface ConfigParams {
  // Access token to read/modify runtime config
  config_auth_token: string;
  // UUID length
  uuid_length: number;
  // Base path to this service
  public_url: string;
  // Base path to frontend assets
  frontend_url?: string;
  // Allowed CORS domains
  cors_domain?: string[];
  // Storage configurations
  storages: StorageConfigParams[];
}
```

`access_key_id` and `secret_access_key` is the access credentials to any S3-compatible object storage service or self-hosted S3 API endpoint.

### Example runtime config
```typescript
{
  "config_auth_token": "auth-token",
  "uuid_length": 4,
  "public_url": "pb.nekoid.cc",
  // Here I use my github repository as static file host
  "frontend_url": "https://raw.githubusercontent.com/rikkaneko/paste/main/frontend",
  // Need to match your public domain
  "cors_domain": ["*.nekoid.cc"],
  "storages": [
    {
      "name": "default",
      "endpoint": "https://s3.exmaple.com",
      "download_endpoint": "https://s3-cdn.exmaple.com",
      "bucket_name": "bucket-1",
      "access_key_id": "access-key-id-1",
      "secret_access_key": "secret-access-key-1",
      "max_file_size": 10485760
    },
    {
      "name": "large",
      "endpoint": "https://s3.exmaple.com",
      "bucket_name": "bucket-2",
      "access_key_id": "access-key-id-2",
      "secret_access_key": "secret-access-key-2",
      "max_file_size": 1073741824
    }
  ]
}
```

Note that `default` storage is mandatory for the normal operation for this service.

## Usage

### **curl, wget or other command line tools**

Upload a file (Raw body) with password enabled

```sh
curl -g -X POST -T <file-path> -H "x-auth-key: exmaple1234" "https://pb.nekoid.cc"
```

Upload a file (Formdata) with password enabled

```shell
curl -F u=@<file-path> -F "auth-key=example1234" "https://pb.nekoid.cc"
```

Upload command ouput as paste

```shell
lspci -v | curl -F u=@- 'https://pb.nekoid.cc'
```

Update a paste with QR code generation of paste link

```shell
echo "Hello, world!" | curl -F u=@- 'https://pb.nekoid.cc?qr=1'
```

Get paste

```shell
curl https://pb.nekoid.cc/<uuid>
```

Delete paste

```shell
curl -X DELETE https://pb.nekoid.cc/<uuid>
```

### **Web**

Use [pb.nekoid.cc](https://pb.nekoid.cc) to submit HTTP form, as same as `curl`.  
This HTML form currenly only support paste upload.

## API Specification

### `GET /`

Fetch the Web frontpage HTML for uploading text/file (used for browsers)

### `GET /api`

Fetch API specification

### `GET /<uuid>`

Fetch the paste by uuid. *If the password is set, this request requires additional `x-auth-key` header or to
use [HTTP Basic authentication](https://en.wikipedia.org/wiki/Basic_access_authentication).*

### `POST /`

Create new paste. Currently, only `multipart/form-data` and raw request are supported.  
Add `?qr=1` to enable QR code generation for paste link.

#### For `multipart/form-data` request,

|Form Key|Description|
|-|-|
|`u`|Upload content|
|`auth-key`|Password|
|`read-limit`|The maximum access count|
|`qrcode`|Toggle QR code generation|
|`paste-type`|Set paste type|
|`title`|File title|
|`mime-type`|The media type (MIME) of the data and encoding|
|`json`|Use JSON response|

#### For raw request,

|Header Key|Description|
|-|-|
|`x-content-type`|The media type (MIME) of the data and encoding|
|`x-title`|File title|
|`x-auth-key`|Password|
|`x-read-limit`|The maximum access count|
|`x-paste-type`|Set paste type|
|`x-qr`|Toggle QR code generation|
|`x-json`|Use JSON response|

The request body contains the upload content.

#### Paste type

|Type|Description|
|-|-|
|`paste`|Normal paste|
|`large_paste`|Large paste|
|`link`|URL link to be redirected|

#### Response

Upon a successful upload using `POST /` or a call to `GET /<uuid>/settings`, the endpoint will respond in the following format

In default mode, designed for text console:
```
uuid: MRFS
link: https://pb.nekoid.cc/MRFS
type: paste
title: satanichia.png
mime-type: image/png
size: 2420328 bytes (2.308 MiB)
password: false
access times: 5
max_access_n: -
created at 2025-08-01T06:59:44.336Z
expired at 2025-08-29T06:59:44.336Z
```

In JSON mode (`?json=1`)
```json
{
  "uuid":"MRFS",
  "link":"https://pb.nekoid.cc/MRFS",
  "link_qr":"https://qrcode.nekoid.cc/?q=https%3A%2F%2Fpb.nekoid.cc%2FMRFS&type=svg",
  "type":"paste",
  "title":"satanichia.png",
  "mime_type":"image/png",
  "human_readable_size":"2.308 MiB",
  "size":2420328,
  "password":false,
  "access_n":5,
  "created":"2025-08-01T06:59:44.336Z",
  "expired":"2025-08-29T06:59:44.336Z"
}
```

### `GET /<uuid>/<option>`

Fetch the paste (code) in rendered HTML with syntax highlighting  
Add `?qr=1` to enable QR code generation for paste link.  
Currently, only the following options is supported for `option`

|Option|Meaning|
|-|-|
|`settings`|Fetch the paste information|
|`download`|Download paste as attachment|
|`raw`|Display paste as plain text|
|`link`|Treat paste content as URL link|
|`presign`|Redirect to the presigned URL of the paste (large_paste only)|

*The authentication requirement is as same as `GET /<uuid>`.*

### `DELETE /<uuid>`

Delete paste by uuid. *If the password is set, this request requires additional `x-auth-key` header*

## Paste V2 RESTful API

At the start of this project, the service code was designed to allow users to upload text via an HTTP form and display the response in the browser. However, handling form data is troublesome. The new version 2 of the RESTful API is more programmer-friendly and simplifies request validation using [forgjs](https://github.com/oussamahamdaoui/forgJs). The V1 API will continue to remain for creating paste from console.  

### General Resposne

#### On success

```typescript
{
  "status_code": <status-code>,
  "schema-name": { ... }
}
```
`schema-name` is the type name of the response object, specifically `PasteCreateUploadResponse`, `PasteInfo` and `Config`.

#### On error

```typescript
{
  "status_code": <status-code>,
  "message": "error-text"
}
```

### `GET /v2/info/<uuid>`

Retrieve paste info

### Response

A `PasteInfo` object on success.

```typescript
export interface PasteInfo {
  uuid: string;
  paste_type: PasteType;
  title?: string;
  file_size: number;
  mime_type?: string;
  has_password: boolean;
  // Storage location
  location?: string;
  access_n: number;
  max_access_n?: number;
  created_at: number;
  expired_at: number;
}
```

### `POST /v2/info/<uuid>`

If the paste has password, authentication is required via `x-auth-key` headers or query parameters and Bearer authentication.

#### Request

Accept a `PasteInfoUpdateParams` object in `application/json`.

```typescript
export interface PasteInfoUpdateParams {
  password?: string;
  max_access_n?: number;
  title?: string;
  mime_type?: string;
  expired_at?: number;
}
```

#### Response

### `POST /v2/create`

Generate the presigned URL for upload large paste to the underlying S3 endpoint.

#### Request

Accept a `PasteCreateParams` object in `application/json`.

```typescript
export interface PasteCreateParams {
  password?: string;
  max_access_n?: number;
  title?: string;
  mime_type?: string;
  file_size: number;
  // 64 digit SHA256 checksum hex
  file_hash: string;
  // Select the storage location for this new upload request
  location?: string;
  // Expired time in UNIX timestamp
  expired_at?: number;
}
```

#### Response

A `PasteCreateUploadResponse` object on success.

```typescript
export interface PasteCreateUploadResponse {
  uuid: string;
  expiration: number;
  upload_url: string;
  request_headers: {
    'Content-Length': string;
    'x-amz-checksum-sha256': string;
  };
}
```

Then, you can upload the file to `upload_url` using `PUT` method **with and only** with the headers supplied in `request_headers`. You can find reference code to perform the transection in the [frontend code](https://github.com/rikkaneko/paste/blob/e391cf1cece044786596fee930b282cd57cae59e/frontend/static/paste.js#L308).

Note that you can only upload the specific file matching the `file_size` and `file_hash` provided in `/v2/create` request.

### `POST /v2/complete/<uuid>`

Finialize the paste created from `/v2/create`.

#### Response

A `PasteInfo` object on success.

### `GET /v2/config`
> [!WARNING] 
> Anyone knows the `auth-token` can view/modify the entire runtime config.

Authentication via `x-auth-token` headers or query parameters and Bearer authentication.  
For security concern, the value of the `access_key_id` and `secret_access_key` for each storage profile is marked.

#### Response

A [Config](#runtime-config-schema) object on success.

### `POST /v2/config`
> [!WARNING] 
> Anyone knows the `auth-token` can view/modify the entire runtime config.

Authentication via `x-auth-token` headers or query parameters and Bearer authentication.

#### Request

Accept a [Config](#runtime-config-schema) object in `application/json`.

## Expiring paste

S3 object lifecycle rules and Cloudflare KV's expiring key can be used to implemented expiring paste.  
Reference for Amazon S3 can be found in [here](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lifecycle-mgmt.html)
, and Blackblaze B2 in [here](https://www.backblaze.com/b2/docs/lifecycle_rules.html).

## Paste API client
The Paste API client for the command line interface (CLI), as well as versions for Android and iOS, will be available soon. :D

## Remark

You are welcome to use my project and depoly your own service. Contribute and report issues are also welcome! \:D