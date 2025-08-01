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
- [x] Password protection (support [HTTP Basic authentication](https://en.wikipedia.org/wiki/Basic_access_authentication) and `x-pass` header)
- [x] Limit access times
- [x] View paste in browsers (only for text and media file)
- [ ] Expiring paste (*not support directly, see [this section](#expiring-paste)*)
- [ ] Render paste code with syntax highlighting
- [x] Generate QR code for paste link
- [x] Support URL redirection using [HTTP status codes 301](https://en.wikipedia.org/wiki/URL_redirection#HTTP_status_codes_3xx)

## Service architecture

This project is designed to use a S3-compatible object storage (via [aws4fetch](https://github.com/mhart/aws4fetch)) as the backend storage
and [Cloudflare Worker KV](https://developers.cloudflare.com/workers/runtime-apis/kv) as index.
All requests are handled by [Cloudflare Worker](https://developers.cloudflare.com/workers) with the entry point `fetch()`.  
It is worth noting that Cloudflare Worker is run *before* the cache. Therefore, all requests will not be cached.
[Cache API](https://developers.cloudflare.com/workers/runtime-apis/cache/) is used instead to interact with Cloudflare cache.

## Environment variable

|Variable name|Description|
|-|-|
|`SERVICE_URL`|Service URL|
|`PASTE_INDEX_HTML_URL`|Service frontpage HTML URL|
|`UUID_LENGTH`|The length of the UUID of the paste (Default: 4)|
|`PASTE_INDEX`|Cloudflare KV namespace ID|
|`AWS_ACCESS_KEY_ID`|AWS access key|
|`AWS_SECRET_ACCESS_KEY`|AWS secret key|
|`ENDPOINT`|S3 endpoint|
|`LARGE_AWS_ACCESS_KEY_ID`|AWS access key for `LARGE_ENDPOINT`|
|`LARGE_AWS_SECRET_ACCESS_KEY`|AWS secret key for `LARGE_ENDPOINT`|
|`LARGE_ENDPOINT`|S3 endpoint to upload *large paste*|
|`LARGE_DOWNLOAD_ENDPOINT`|S3/CDN endpoint/ to retrieve *large paste*|

`AWS_ACCESS_*` and `LARGE_AWS_ACCESS_*` is the access credentials to S3-compatible object storages.  
These environment variable can be set in `wrangler.toml` or using the following command:
```sh
$ pnpm wrangler secret put <KEY>
```

## Usage

### **curl, wget or other command line tools**

Upload a file (Raw body) with password enabled

```sh
$ curl -g -X POST -T <file-path> -H "x-pass: exmaple1234" "https://pb.nekoid.cc"
```

Upload a file (Formdata) with password enabled

```shell
$ curl -F u=@<file-path> -F "pass=example1234" "https://pb.nekoid.cc"
```

Upload command ouput as paste

```shell
$ lspci -v | curl -F u=@- 'https://pb.nekoid.cc'
```

Update a paste with QR code generation of paste link

```shell
$ echo "Hello, world!" | curl -F u=@- 'https://pb.nekoid.cc?qr=1'
```

Get paste

```shell
$ curl https://pb.nekoid.cc/<uuid>
```

Delete paste

```shell
$ curl -X DELETE https://pb.nekoid.cc/<uuid>
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

Fetch the paste by uuid. *If the password is set, this request requires additional `x-pass` header or to
use [HTTP Basic authentication](https://en.wikipedia.org/wiki/Basic_access_authentication).*

### `POST /`

Create new paste. Currently, only `multipart/form-data` and raw request are supported.  
Add `?qr=1` to enable QR code generation for paste link.

#### For `multipart/form-data` request,

|Form Key|Description|
|-|-|
|`u`|Upload content|
|`pass`|Password|
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
|`x-pass`|Password|
|`x-read-limit`|The maximum access count|
|`x-paste-type`|Set paste type|
|`x-qr`|Toggle QR code generation|
|`x-json`|Use JSON response|

The request body contains the upload content.

#### Paste type

|Type|Description|
|-|-|
|`paste`|Normal paste (<25MB)|
|`large_paste`|Large paste(>25MB)|
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

*The authentication requirement is as same as `GET /<uuid>`.*

### `DELETE /<uuid>`

Delete paste by uuid. *If the password is set, this request requires additional `x-pass` header*

### `POST /api/large_upload/create`

Generate the presigned URL for upload large paste to the given S3 endpoint `LARGE_ENDPOINT` using HTTP `PUT` request.

#### For `multipart/form-data` request,

|Form Key|Description|
|-|-|
|`title`|File title|
|`file-size`|File size|
|`file-sha256-hash`|File hash (SHA256)|
|`mime-type`|The media type (MIME) of the data and encoding|
|`read-limit`|The maximum access count|
|`pass`|Password|

The `file-size` and `file-sha256sum` field is required.

#### Response
```json
{
  "uuid": "<new-uuid>",
  "expiration": <expiration-time>,
  "file_size": <expected-upload-file-size>,
  "file_hash": "<expected-upload-file-hash>",
  "signed_url": "<upload-path>",
  "required_headers": {
    "Content-Length": "<expected-upload-file-size>",
    "X-Amz-Content-Sha256": "<expected-upload-file-hash>"
  }
}
```

Then, you can upload the file to `signed_url` using `PUT` method with and only with the headers supplied in `required_headers`. You can find reference code to perform the transection in the [frontend code](https://github.com/rikkaneko/paste/blob/2d7ce3f1c435103b7f676b0b325c1e0036afaded/frontend/static/paste.js#L274).

Note that you can only upload the specific file matching the `file-size` and `file-sha256-hash` provided in `/create` request.

### `POST /api/large_upload/complete/<uuid>`

Finialize the paste created from `/api/large_upload/create`.

### `GET /api/large_upload/<uuid>`

Generate the presigned URL for upload large paste to the given S3 endpoint `LARGE_DOWNLOAD_ENDPOINT` using HTTP `GET` request.

## Expiring paste

S3 object lifecycle rules and Cloudflare KV's expiring key can be used to implemented expiring paste.  
Reference for Amazon S3 can be found in [here](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lifecycle-mgmt.html)
, and Blackblaze B2 in [here](https://www.backblaze.com/b2/docs/lifecycle_rules.html).

## Paste API client
The Paste API client for the command line interface (CLI), as well as versions for Android and iOS, will be available soon. :D

## Remark

You are welcome to use my project and depoly your own service.  
Due to the fact that the `SERVICE_URL` is hard-coded into the `paste.html`,
you may simply use `Ctrl`+`R` to replace `pb.nekoid.cc` with your own service URL.  

Of course, contribute and report issues are also welcome! \:D