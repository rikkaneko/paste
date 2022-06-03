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
        const s3 = new AwsClient({
            accessKeyId: env.AWS_ACCESS_KEY_ID,
            secretAccessKey: env.AWS_SECRET_ACCESS_KEY
        });

        // Special path
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
                    let mime: string | undefined;
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
                                mime = contentType(title) || undefined;
                            }
                            buffer = await data.arrayBuffer();
                        // Text
                        } else {
                            buffer = new TextEncoder().encode(data)
                            mime = "text/plain; charset=UTF-8;"
                        }

                    // Raw body
                    } else {
                        if (headers.has("title")) {
                            title = headers.get("title")!;
                            mime = contentType(title) || undefined;
                        }
                        mime = headers.get("content-type") ?? mime;
                        buffer = await request.arrayBuffer();
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
                            mime_type: mime,
                            last_modified: Date.now()
                        };

                        const p1 = env.PASTE_INDEX.get("__count__").then(counter => {
                            env.PASTE_INDEX.put("__count__", (Number(counter ?? "0") + 1).toString());
                        });
                        const p2 = env.PASTE_INDEX.put(uuid, JSON.stringify(descriptor));
                        await Promise.all([p1, p2]);
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

                        if (option === "download") {
                            res.headers.set("content-disposition",
                                `attachment; filename="${encodeURIComponent(descriptor.title ?? uuid)}"`);
                        }

                        // res.body cannot be read twice
                        await cache.put(request.url, res.clone());
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

                    let res = await s3.fetch(`${env.ENDPOINT}/${uuid}`, {
                        method: "DELETE"
                    });

                    if (res.ok) {
                        await env.PASTE_INDEX.delete(uuid);
                        const counter = await env.PASTE_INDEX.get("__count__") || "1";
                        await env.PASTE_INDEX.put("__count__", (Number(counter) - 1).toString());

                        // Invalidate CF cache
                        await cache.delete(request.url);
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
created at ${date.toISOString()}
`
}

interface PasteIndexEntry {
    title?: string,
    mime_type?: string,
    last_modified: number,
    password?: string
    editable?: boolean // Default: True
}