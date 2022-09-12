# Paste

This is a pastebin-like, simple file sharing application targeted to run on Cloudflare Worker.  
[pb.nekoul.com](http://pb.nekoul.com) is the current deployment of this project.  
The maximum upload file size is limited to **10 MB** and the paste will be kept for **28 days** only by default.  
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

## Service architecture

This project is designed to use a S3-compatible object storage (via [aws4fetch](https://github.com/mhart/aws4fetch)) as the backend storage
and [Cloudflare Worker KV](https://developers.cloudflare.com/workers/runtime-apis/kv) as index.
All requests are handled by [Cloudflare Worker](https://developers.cloudflare.com/workers) with the entry point `fetch()`.  
It is worth noting that Cloudflare Worker is run *before* the cache. Therefore, all requests will not be cached.
[Cache API](https://developers.cloudflare.com/workers/runtime-apis/cache/) is used instead to interact with Cloudflare cache.

## Environment variable

|Name|Description|
|-|-|
|`SERVICE_URL`|The URL of the service|
|`PASTE_INDEX_HTML_URL`|The URL of the service frontpage HTML|
|`UUID_LENGTH`|The length of the UUID of the paste (Default: 4)|
|`PASTE_INDEX`|The Unique ID of Cloudflare KV namespace|
|`AWS_ACCESS_KEY_ID`|The AWS access key|
|`AWS_SECRET_ACCESS_KEY`|The AWS secret key|
|`ENDPOINT`|The gateway endpoint to the S3 service|

(Compatible to any S3-compatible object storage)  
**`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and `ENDPOINT` should be kept secret,
i.e., [put into the encrypted store](https://developers.cloudflare.com/workers/platform/environment-variables/#adding-secrets-via-wrangler)
.**

## Usage

### **curl, wget or other command line tools**

Upload a file (Raw body) with password enabled

```sh
$ curl --data-binary @example.txt -H "x-pass: exmaple1234" "https://pb.nekoul.com"
```

Upload a file (Formdata) with password enabled

```shell
$ curl -F @exmaple.txt -F "pass=example1234" "https://pb.nekoul.com"
```

Upload command ouput as paste

```shell
$ lspci -v | curl -F u=@- 'https://pb.nekoul.com'
```

Update a paste with QR code generation of paste link

```shell
$ echo "Hello, world!" | curl -F u=@- 'https://pb.nekoul.com?qr=1'
```

Get paste

```shell
$ curl https://pb.nekoul.com/uuid
```

Delete paste

```shell
$ curl -X DELETE https://pb.nekoul.com/uuid
```

### **Web**

Use [pb.nekoul.com](https://pb.nekoul.com) to submit HTTP form, as same as `curl`.  
This HTML form currenly only support paste upload.

## API Specification

### GET /

Fetch the Web frontpage HTML for uploading text/file (used for browsers)

### GET /api

Fetch API specification

### GET /\<uuid\>

Fetch the paste by uuid. *If the password is set, this request requires additional `x-pass` header or to
use [HTTP Basic authentication](https://en.wikipedia.org/wiki/Basic_access_authentication).*

### POST /

Create new paste. Currently, only `multipart/form-data` and raw request are supported.  
Add `?qr=1` to enable QR code generation for paste link.

#### For `multipart/form-data` request,

|Form Key|Description|
|-|-|
|`u`|Upload content|
|`pass`|Paste's password|
|`read-limit`|The maximum access count|
|`qrcode`|Toggle QR code generation|

#### For raw request,

|Header Key|Description|
|-|-|
|`x-content-type`|The media type (MIME) of the data and encoding|
|`x-title`|File's title|
|`x-pass`|Paste's password|
|`x-read-limit`|The maximum access count|

The request body contains the upload content.

### GET /\<uuid\>/\<option\> (Not implemented)

Fetch the paste (code) in rendered HTML with syntax highlighting  
Add `?qr=1` to enable QR code generation for paste link.  
Currently, only the following options is supported for `option`
|Option|Meaning|
|-|-|
|`settings`|Fetch the paste information|
|`download`|Download paste as attachment|
|`raw`|Display paste as plain text|

*The authentication requirement is as same as `GET /<uuid>`.*

### DELETE /\<uuid\>

Delete paste by uuid. *If the password is set, this request requires additional `x-pass` header*

### POST /\<uuid\>/settings (Not implemented)

Update paste setting. *If the password is set, this request requires additional `x-pass` header*

## Expiring paste

S3 object lifecycle rules and Cloudflare KV's expiring key can be used to implemented expiring paste.  
Reference for Amazon S3 can be found in [here](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lifecycle-mgmt.html)
, and Blackblaze B2 in [here](https://www.backblaze.com/b2/docs/lifecycle_rules.html).

## Remark

You are welcome to use my project and depoly your own service.  
Due to the fact that the `SERVICE_URL` is hard-coded into the `paste.html`,
you may simply use `Ctrl`+`R` to replace `pb.nekoul.com` with your own service URL.  

### Of course, contribute and report issues are also welcome! \:D