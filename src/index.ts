/*
 * This file is part of paste.
 * Copyright (c) 2022 Joe Ma <rikkaneko23@gmail.com>
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Lesser General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import {AwsClient} from "aws4fetch";
import {customAlphabet} from "nanoid";
import {contentType} from "mime-types";
import {sha256} from "js-sha256";

// Constants
const SERVICE_URL = "pb.nekoul.com"
const PASTE_INDEX_HTML_URL = "https://raw.githubusercontent.com/rikkaneko/paste/main/paste.html"
const UUID_LENGTH = 4

export interface Env {
    PASTE_INDEX: KVNamespace;
    AWS_ACCESS_KEY_ID: string;
    AWS_SECRET_ACCESS_KEY: string;
    ENDPOINT: string
}

const API_SPEC_TEXT =
    `Paste service https://${SERVICE_URL}

[API Specification]
GET /                   Fetch the Web frontpage for uploading text/file [x]
GET /api                Fetch API specification
GET /<uuid>             Fetch the paste by uuid [x]
GET /<uuid>/<lang>      Fetch the paste (code) in rendered HTML with syntax highlighting [ ]
GET /<uuid>/settings    Fetch the paste information [x]
GET /<uuid>/download    Download the paste [x]
POST /                  Create new paste [x] # Only support multipart/form-data and raw data
DELETE /<uuid>          Delete paste by uuid [x]
POST /<uuid>/settings   Update paste setting, i.e., passcode and valid time [ ]

* uuid: [A-z0-9]{${UUID_LENGTH}}
* option: Render language

Features
* Password protection [ ]
* Expiring paste [ ]

[ ] indicated not implemented

Limitation
* Max. 10MB file size upload (Max. 100MB body size for free Cloudflare plan) 

Last update on 2 June.
`;

const gen_id = customAlphabet(
    "1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz", UUID_LENGTH);

export default {
    async fetch(
        request: Request,
        env: Env,
        ctx: ExecutionContext
    ): Promise<Response> {
        const {url, method, headers} = request;
        const {pathname} = new URL(url);
        const path = pathname.replace(/\/+$/, "") || "/";
        let cache = caches.default;
        // Bypass script will also bypass (1) password authentication and (2) auto expire on access count
        // Bypass script to get cached response faster
        // if (method == "GET") {
        //     let cached = await cache.match(url);
        //     if (cached !== undefined) {
        //         let {readable, writable} = new TransformStream();
        //         cached.body!.pipeTo(writable);
        //         return new Response(readable, cached);
        //     }
        // }

        const s3 = new AwsClient({
            accessKeyId: env.AWS_ACCESS_KEY_ID,
            secretAccessKey: env.AWS_SECRET_ACCESS_KEY
        });

        // Special path
        if (path === "/favicon.ico" && method == "GET") {
            return new Response(null, {
                status: 404
            })
        }

        if (path === "/api" && method == "GET") {
            return new Response(API_SPEC_TEXT);
        }

        if (path === "/") {
            switch (method) {
                // Fetch the HTML for uploading text/file
                case "GET": {
                    return await fetch(PASTE_INDEX_HTML_URL, {
                        cf: {
                            cacheEverything: true
                        }
                    }).then(value => {
                        let res = new Response(value.body, value);
                        // Add the correct content-type to response header
                        res.headers.set("content-type", "text/html; charset=UTF-8;");
                        // Remove the default CSP header
                        res.headers.delete("content-security-policy");
                        return res;
                    })
                }

                // Create new paste
                case "POST":
                    const uuid = gen_id();
                    let buffer: ArrayBuffer;
                    let title: string | undefined;
                    // Handle content-type
                    const content_type = headers.get("content-type") || "";
                    let mime_type: string | undefined;
                    let password: string | undefined;
                    let read_limit: number | undefined;
                    // Content-Type: multipart/form-data
                    if (content_type.includes("form")) {
                        const formdata = await request.formData();
                        const data = formdata.get("u");
                        if (data === null) {
                            return new Response("Invalid request.\n", {
                                status: 422
                            })
                        }
                        // File
                        if (data instanceof File) {
                            if (data.name) {
                                title = data.name;
                                mime_type = contentType(title) || undefined;
                            }
                            buffer = await data.arrayBuffer();
                        // Text
                        } else {
                            buffer = new TextEncoder().encode(data)
                            mime_type = "text/plain; charset=UTF-8;"
                        }

                        // Set password
                        const pass = formdata.get("pass");
                        if (typeof pass === "string") {
                            password = pass || undefined;
                        }

                        const count = formdata.get("read-limit");
                        if (typeof count === "string" && !isNaN(+count)) {
                            read_limit = Number(count) || undefined;
                        }

                    // Raw body
                    } else {
                        if (headers.has("title")) {
                            title = headers.get("title") || "";
                            mime_type = contentType(title) || undefined;
                        }
                        mime_type = headers.get("content-type") || mime_type;
                        password = headers.get("pass") || undefined;
                        // Handle read-limit:read_count_remain
                        const count = headers.get("read-limit") || undefined;
                        if (count !== undefined && !isNaN(+count)) {
                            read_limit = Number(count) || undefined;
                        }
                        buffer = await request.arrayBuffer();
                    }

                    // Check password rules
                    if (password && !check_password_rules(password)) {
                        return new Response("Invalid password. " +
                            "Password must contain alphabets and digits only, and has a length of 4 or more.", {
                            status: 422
                        })
                    }

                    // Check request.body size <= 10MB
                    if (buffer.byteLength > 10485760) {
                        return new Response("Paste size must be under 10MB.\n", {
                            status: 422
                        });
                    }

                    // Check request.body size not empty
                    if (buffer.byteLength == 0) {
                        return new Response("Paste cannot be empty.\n", {
                            status: 422
                        });
                    }

                    const res = await s3.fetch(`${env.ENDPOINT}/${uuid}`, {
                        method: "PUT",
                        body: buffer
                    });

                    if (res.ok) {
                        // Upload success
                        const descriptor: PasteIndexEntry = {
                            title: title ?? undefined,
                            last_modified: Date.now(),
                            password: password? sha256(password).slice(0, 16): undefined,
                            read_count_remain: read_limit,
                            mime_type
                        };

                        ctx.waitUntil(env.PASTE_INDEX.put(uuid, JSON.stringify(descriptor)));
                        return new Response(get_paste_info(uuid, descriptor));
                    } else {
                        return new Response("Unable to upload the paste.\n", {
                            status: 500
                        });
                    }

            }

        } else if (path.length >= UUID_LENGTH + 1) {
            // RegExpr to match /<uuid>/<option>
            const found = path.match("/(?<uuid>[A-z0-9]+)(?:/(?<option>[A-z]+))?$");
            if (found === null) {
                return new Response("Invalid path.\n", {
                    status: 403
                })
            }
            // @ts-ignore
            const {uuid, option} = found.groups;
            // UUID format: [A-z0-9]{UUID_LENGTH}
            if (uuid.length !== UUID_LENGTH) {
                return new Response("Invalid UUID.\n", {
                    status: 442
                })
            }
            const val = await env.PASTE_INDEX.get(uuid);
            if (val === null) {
                return new Response("Paste not found.\n", {
                    status: 404
                });
            }
            const descriptor: PasteIndexEntry = JSON.parse(val);

            // Handling /<uuid>/settings
            if (option === "settings") {
                switch(method) {
                    case "GET":
                        return new Response(get_paste_info(uuid, descriptor));

                    case "POST": {
                        // TODO Implement paste setting update
                        return new Response("Service is under maintainance.\n", {
                            status: 422
                        });
                    }
                }

            }

            switch (method) {
                // Fetch the paste by uuid
                case "GET": {
                    // Check password if needed
                    if (descriptor.password !== undefined) {
                        if (headers.has("Authorization")) {
                            let cert = get_basic_auth(headers);
                            // Error occurred when parsing the header
                            if (cert === null) {
                                return new Response("Invalid Authorization header.", {
                                    status: 400
                                })
                            }
                            // Check password and username should be empty
                            if (cert[0].length != 0 || descriptor.password !== sha256(cert[1]).slice(0, 16)) {
                                return new Response(null, {
                                    status: 401,
                                    headers: {
                                        "WWW-Authenticate": "Basic realm=\"Requires password\""
                                    }
                                })
                            }
                        } else {
                            return new Response(null, {
                                status: 401,
                                headers: {
                                    "WWW-Authenticate": "Basic realm=\"Requires password\""
                                }
                            })
                        }
                    }

                    // Check if access_count_remain entry present
                    if (descriptor.read_count_remain !== undefined) {
                        if (descriptor.read_count_remain <= 0) {
                            return new Response("Paste expired.\n", {
                                status: 410
                            })
                        }
                        descriptor.read_count_remain--;
                        ctx.waitUntil(env.PASTE_INDEX.put(uuid, JSON.stringify(descriptor)));
                    }

                    // Enable CF cache for authorized request
                    // Match in existing cache
                    let res = await cache.match(request.url);
                    if (res === undefined) {
                        // Fetch form origin if not hit cache
                        let origin = await s3.fetch(`${env.ENDPOINT}/${uuid}`, {
                            method: "GET"
                        });

                        res = new Response(origin.body, origin);

                        if (!res.ok) {
                            // UUID exists in index but not found in remote object storage service
                            return new Response("Internal server error.\n", {
                                status: 500
                            });
                        }

                        // Remove x-amz-* headers
                        for (let [key, value] of res.headers.entries()) {
                            if (key.startsWith("x-amz")) {
                                res.headers.delete(key);
                            }
                        }

                        res.headers.set("cache-control", "public, max-age=18000");
                        res.headers.set("content-type", descriptor.mime_type ?? "application/octet-stream");
                        res.headers.set("content-disposition",
                            `inline; filename="${encodeURIComponent(descriptor.title ?? uuid)}"`);

                        if (option === "download") {
                            res.headers.set("content-disposition",
                                `attachment; filename="${encodeURIComponent(descriptor.title ?? uuid)}"`);
                        }

                        // res.body cannot be read twice
                        // Do not block when writing to cache
                        ctx.waitUntil(cache.put(url, res.clone()));
                        return res;
                    }

                    // Cache hit
                    let { readable, writable } = new TransformStream();
                    res.body!.pipeTo(writable);
                    return new Response(readable, res);
                }

                // Delete paste by uuid
                case "DELETE": {
                    if (descriptor.editable !== undefined && !descriptor.editable) {
                        return new Response("This paste is immutable.\n", {
                            status: 405
                        });
                    }

                    // Check password if needed
                    if (descriptor.password !== undefined) {
                        if (headers.has("pass")) {
                            const pass = headers.get("pass");
                            if (descriptor.password !== sha256(pass!).slice(0, 16)) {
                                return new Response("Incorrect password.\n", {
                                    status: 403
                                });
                            }
                        } else {
                            return new Response("This operation requires password.\n", {
                                status: 401
                            })
                        }
                    }

                    let res = await s3.fetch(`${env.ENDPOINT}/${uuid}`, {
                        method: "DELETE"
                    });

                    if (res.ok) {
                        ctx.waitUntil(env.PASTE_INDEX.delete(uuid));
                        // Invalidate CF cache
                        ctx.waitUntil(cache.delete(url));
                        return new Response("OK\n");
                    } else {
                        return new Response("Unable to process such request.\n", {
                            status: 500
                        });
                    }
                }
            }
        }

        // Default response
        return new Response("Invalid path.\n", {
            status: 403
        });
    },
};

function get_paste_info(uuid: string, descriptor: PasteIndexEntry): string {
    const date = new Date(descriptor.last_modified)
    return `link: https://${SERVICE_URL}/${uuid}
id: ${uuid}
title: ${descriptor.title || "<empty>"}
mime-type: ${descriptor.mime_type ?? "application/octet-stream"}
password: ${(!!descriptor.password)}
editable: ${descriptor.editable? descriptor.editable: true}
remaining read count: ${descriptor.read_count_remain !== undefined? 
        descriptor.read_count_remain? descriptor.read_count_remain: `0 (expired)`: "-"}
created at ${date.toISOString()}
`
}

function check_password_rules(password: string): boolean {
    return password.match("^[A-z0-9]{4,}$") !== null;
}

// Extract username and password from Basic Authorization header
function get_basic_auth(headers: Headers): [string, string] | null {
    if (headers.has("Authorization")) {
        const auth = headers.get("Authorization");
        const [scheme, encoded] = auth!.split(" ");
        // Validate authorization header format
        if (!encoded || scheme !== "Basic") {
            return null;
        }
        // Decode base64 to string (UTF-8)
        const buffer = Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
        const decoded = new TextDecoder().decode(buffer).normalize();
        const index = decoded.indexOf(':');

        // Check if user & password are split by the first colon and MUST NOT contain control characters.
        if (index === -1 || decoded.match("[\\0-\x1F\x7F]")) {
            return null;
        }

        return [decoded.slice(0, index), decoded.slice(index + 1)];

    } else {
        return null;
    }
}

interface PasteIndexEntry {
    title?: string,
    mime_type?: string,
    last_modified: number,
    password?: string
    editable?: boolean, // Default: True
    read_count_remain?: number
}