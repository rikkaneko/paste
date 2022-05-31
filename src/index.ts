import {AwsClient} from "aws4fetch";
import { customAlphabet } from 'nanoid'

// Constants
const SERVICE_URL = "https://paste.nekoul.com"

export interface Env {
    PASTE_INDEX: KVNamespace;
    AWS_ACCESS_KEY_ID: string;
    AWS_SECRET_ACCESS_KEY: string;
    ENDPOINT: string
}

const API_DOCS =
    `Paste service https://paste.nekoul.com

[API Draft]
GET /                Fetch the HTML for uploading text/file [ ]
GET /<uuid>          Fetch the paste by uuid [x]
GET /<uuid>/<lang>   Fetch the paste (code) in rendered HTML with syntax highlighting [ ]
GET /<uuid>/settings   Fetch the paste information [x]
GET /status          Fetch service information [x]
PUT /                Create new paste [x]
POST /<uuid>         Update the paste by uuid [x]
DELETE /<uuid>       Delete paste by uuid [x]
POST /<uuid>/settings  Update paste setting, i.e., passcode and valid time [ ]

[ ] indicated not implemented

Limitation
* Max. 10MB file size upload (Max. 100MB body size for free Cloudflare plan) 

Last update on 30 May.
`;

const gen_id = customAlphabet(
    "1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz", 8);

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

        // if (hostname !== SERVICE_URL) {
        //     // Invalid case
        //     return new Response(null, { status: 403 })
        // }

        if (path === "/") {
            switch (method) {
                // Fetch the HTML for uploading text/file
                case "GET":
                    return new Response(API_DOCS);

                // Create new paste
                case "PUT":
                    let uuid = gen_id();
                    let buffer = await request.arrayBuffer();
                    // Check request.body size <= 10MB
                    if (buffer.byteLength > 10485760) {
                        return new Response("File size must be under 10MB.\n");
                    }

                    let res = await s3.fetch(`${env.ENDPOINT}/${uuid}`, {
                        method: "PUT",
                        body: buffer
                    });

                    if (res.ok) {
                        // Upload success
                        let descriptor: PasteIndexEntry = {
                            title: headers.get("title") || undefined,
                            last_modified: Date.now(),
                            password: undefined,
                            editable: undefined // Default: true
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

        } else if (path.length >= 9) {
            // RegExpr to match /<uuid>/<option>
            const found = path.match("/(?<uuid>[A-z0-9]+)(?:/(?<option>[A-z]+))?$");
            if (found === null) {
                return new Response("Invalid path.\n", {
                    status: 422
                })
            }
            // @ts-ignore
            const {uuid, option} = found.groups;
            // UUID format: [A-z0-9]{8}
            if (uuid.length !== 8) {
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
            if (option !== undefined) {
                if (option === "settings") {
                    switch(method) {
                        case "GET":
                            return new Response(get_paste_info(uuid, descriptor))

                        case "POST": {

                        }
                    }

                } else if (option.length !== 0) {
                    return new Response("Unsupported language.\n", {
                        status: 405
                    })
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
                    return new Response(readable, {
                        // headers: {
                        //     "Content-Disposition": `attachment; filename="${encodeURIComponent(descriptor.title ?? uuid)}"`
                        // }
                    });
                }

                // Update the paste by uuid
                case "POST": {
                    if (!descriptor.editable) {
                        return new Response("This paste does not allow editing.\n", {
                            status: 405
                        });
                    }

                    let buffer = await request.arrayBuffer();
                    // Check request.body size <= 10MB
                    if (buffer.byteLength > 10485760) {
                        return new Response("File size must be under 10MB.\n");
                    }
                    let res = await s3.fetch(`${env.ENDPOINT}/${uuid}`, {
                        method: "PUT",
                        body: buffer
                    });

                    if (res.ok) {
                        // Update last modified time
                        descriptor.last_modified = Date.now();
                        await env.PASTE_INDEX.put(uuid, JSON.stringify(descriptor));
                        return new Response("OK\n");
                    } else {
                        return new Response("Unable to update the paste.\n", {
                            status: 500
                        });
                    }
                }

                // Delete paste by uuid
                case "DELETE": {
                    if (descriptor.editable !== undefined && descriptor.editable) {
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
    return `${SERVICE_URL}/${uuid}
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
    editable?: boolean
}