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
import { customAlphabet } from 'nanoid'

// Constants
const SERVICE_URL = "paste.nekoul.com"
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
        const {hostname, pathname, searchParams} = new URL(url);
        const path = pathname.replace(/\/+$/, "") || "/"
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
                case "GET":
                    return await fetch(PASTE_INDEX_HTML_URL);

                // Create new paste
                case "POST":
                    let uuid = gen_id();
                    let buffer: ArrayBuffer;
                    let title: string | undefined;
                    // Handle content-type
                    const content_type = headers.get("content-type") || "";
                    // Content-Type: multipart/form-data
                    if (content_type.includes("form")) {
                        let formdata = await request.formData();
                        let data = formdata.get("upload-content");
                        if (data === null) {
                            return new Response("Invalid request.\n", {
                                status: 422
                            })
                        }
                        // File
                        if (data instanceof File) {
                            title = data.name ?? undefined;
                            buffer = await data.arrayBuffer();
                        // Text
                        } else {
                            buffer = new TextEncoder().encode(data)
                        }

                    // Raw body
                    } else {
                        title = headers.get("title") ?? undefined;
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

                    let res = await s3.fetch(`${env.ENDPOINT}/${uuid}`, {
                        method: "PUT",
                        body: buffer
                    });

                    if (res.ok) {
                        // Upload success
                        let descriptor: PasteIndexEntry = {
                            title: title ?? undefined,
                            last_modified: Date.now()
                        };

                        let counter = await env.PASTE_INDEX.get("__count__") || "0";
                        await env.PASTE_INDEX.put(uuid, JSON.stringify(descriptor));
                        await env.PASTE_INDEX.put("__count__", (Number(counter) + 1).toString());
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
                    status: 422
                })
            }
            // @ts-ignore
            const {uuid, option} = found.groups;
            // UUID format: [A-z0-9]{UUID_LENGTH}
            if (uuid.length !== UUID_LENGTH) {
                return new Response("Invalid UUID.\n", {
                    status: 422
                })
            }
            let val = await env.PASTE_INDEX.get(uuid);
            if (val === null) {
                return new Response("Paste not found.\n", {
                    status: 404
                });
            }
            let descriptor: PasteIndexEntry = JSON.parse(val);

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
                    let res = await s3.fetch(`${env.ENDPOINT}/${uuid}`, {
                        method: "GET"
                    });
                    // Stream request
                    let {readable, writable} = new TransformStream();
                    if (res.body === null) {
                        // UUID exists in index but not found in remote object storage service
                        return new Response("Internal server error.\n", {
                            status: 500
                        });
                    }
                    // Streaming request
                    res.body.pipeTo(writable);

                    // Handle response format
                    // Direct download
                    if (option === "download") {
                        return new Response(readable, {
                            headers: {
                                "Content-Disposition": `attachment; filename="${encodeURIComponent(descriptor.title ?? uuid)}"`
                            }
                        });
                    }

                    // Default format
                    return new Response(readable);
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
                        let counter = await env.PASTE_INDEX.get("__count__") || "1";
                        await env.PASTE_INDEX.put("__count__", (Number(counter) - 1).toString());
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
    let date = new Date(descriptor.last_modified)
    return `https://${SERVICE_URL}/${uuid}
ID: ${uuid}
Title: ${descriptor.title || "<empty>"}
Password: ${(!!descriptor.password)}
Editable: ${descriptor.editable? descriptor.editable: true}
Last modified at ${date.toISOString()}
`
}

interface PasteIndexEntry {
    title?: string
    last_modified: number,
    password?: string
    editable?: boolean // Default: True
}