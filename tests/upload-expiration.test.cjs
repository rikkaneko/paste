const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const Module = require('node:module');

const projectRoot = join(__dirname, '..');
const outputDir = mkdtempSync(join(tmpdir(), 'paste-route-test-'));
execFileSync(join(projectRoot, 'node_modules/.bin/tsc'), ['--noEmit', 'false', '--outDir', outputDir, '--rootDir', 'src'], {
  cwd: projectRoot,
});

const state = { entries: new Map(), object: null, writes: [], uploads: 0, pending: [], maxFileSize: 100, maxTtl: 86400, corsDomains: [] };
class PutObjectCommand {
  constructor(input) {
    this.input = input;
  }
}
class GetObjectCommand {
  constructor(input) {
    this.input = input;
  }
}
class S3Client {
  async send(command) {
    if (command instanceof PutObjectCommand) {
      state.uploads++;
      state.object = command.input.Body;
      return { $metadata: { httpStatusCode: 200 } };
    }
    if (command instanceof GetObjectCommand) {
      return { $metadata: { httpStatusCode: 200 }, Body: new Blob([state.object]).stream(), ETag: 'test-etag' };
    }
    throw new Error('Unexpected S3 command');
  }
}

class Config {
  static async from_kv() {}
  static get() {
    return new Config();
  }
  config() {
    return { public_url: 'https://pb.example.test', uuid_length: 4, cors_domain: state.corsDomains };
  }
  filter_storage(name) {
    return name === 'default' ? { max_file_size: state.maxFileSize, max_valid_ttl: state.maxTtl } : null;
  }
}

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'itty-router' || request === 'js-sha256') return originalLoad(request, module, isMain);
  if (request === './config') return Config;
  if (request === './proxy') return { serve_static: () => new Response('static') };
  if (request === './v2/api') return { fetch: () => new Response('not tested') };
  if (request === './utils') {
    return {
      check_password_rules: () => true,
      get_paste_info: async (uuid, descriptor) => new Response(JSON.stringify({ uuid, ...descriptor }), {
        headers: { 'content-type': 'application/json' },
      }),
      get_auth: () => null,
      gen_id: () => 'abcd',
      get_presign_url: async () => null,
    };
  }
  if (request === './v2/schema') {
    return { PasteType: { paste: 1, link: 2, large_paste: 3 }, PasteTypeFrom: (value) => value === 'link' ? 2 : 1 };
  }
  if (request === '@aws-sdk/client-s3') {
    return { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand: class {} };
  }
  return originalLoad(request, parent, isMain);
};
const app = require(join(outputDir, 'index.js')).default;
Module._load = originalLoad;

global.caches = { default: { match: async () => undefined, put: async () => undefined, delete: async () => true } };
const env = {
  PASTE_INDEX: {
    get: async (key) => state.entries.get(key) ?? null,
    put: async (key, value, options) => {
      state.entries.set(key, value);
      state.writes.push(options);
    },
    delete: async (key) => state.entries.delete(key),
  },
};
const ctx = { waitUntil: (promise) => state.pending.push(promise) };

beforeEach(() => {
  state.entries.clear();
  state.object = null;
  state.writes = [];
  state.uploads = 0;
  state.pending = [];
  state.maxFileSize = 100;
  state.maxTtl = 86400;
  state.corsDomains = [];
});

test('Text form expiry is stored in milliseconds and sets KV lifetime', async () => {
  const expiry = Date.now() + 3600000;
  const form = new FormData();
  form.set('u', 'hello');
  form.set('paste-type', 'paste');
  form.set('expired_at', String(expiry));
  const response = await app.fetch(new Request('https://pb.example.test/', { method: 'POST', body: form }), env, ctx);
  await Promise.all(state.pending);
  assert.equal(response.status, 200, await response.text());
  assert.equal(JSON.parse(state.entries.get('abcd')).expired_at, expiry);
  assert.equal(JSON.parse(state.entries.get('abcd')).paste_type, 1);
  assert.ok(state.writes[0].expirationTtl <= 3600 && state.writes[0].expirationTtl >= 3598);
});

test('URL form expiry preserves link redirect and absolute KV expiration', async () => {
  const expiry = Date.now() + 3600000;
  const form = new FormData();
  form.set('u', 'https://example.com/target');
  form.set('paste-type', 'link');
  form.set('expired_at', String(expiry));
  const created = await app.fetch(new Request('https://pb.example.test/', { method: 'POST', body: form }), env, ctx);
  await Promise.all(state.pending);
  assert.equal(created.status, 200);
  assert.equal(JSON.parse(state.entries.get('abcd')).paste_type, 2);
  state.pending = [];
  const opened = await app.fetch(new Request('https://pb.example.test/abcd'), env, ctx);
  await Promise.all(state.pending);
  assert.equal(opened.status, 301);
  assert.equal(opened.headers.get('location'), 'https://example.com/target');
  assert.equal(state.writes[1].expiration, Math.ceil(expiry / 1000));
});

test('Missing form expiry retains the seven-day default', async () => {
  const form = new FormData();
  form.set('u', 'hello');
  const response = await app.fetch(new Request('https://pb.example.test/', { method: 'POST', body: form }), env, ctx);
  await Promise.all(state.pending);
  assert.equal(response.status, 200);
  assert.ok(state.writes[0].expirationTtl <= 604800 && state.writes[0].expirationTtl >= 604798);
});

test('Malformed, expired, and excessive form dates are rejected before S3 upload', async () => {
  for (const expiry of ['123bad', String(Date.now() - 1000), String(Date.now() + 2 * 86400000)]) {
    const form = new FormData();
    form.set('u', 'hello');
    form.set('expired_at', expiry);
    const response = await app.fetch(new Request('https://pb.example.test/', { method: 'POST', body: form }), env, ctx);
    assert.equal(response.status, 422);
  }
  assert.equal(state.uploads, 0);
});

test('Default storage without a TTL uses the 28-day maximum', async () => {
  state.maxTtl = undefined;
  const form = new FormData();
  form.set('u', 'hello');
  form.set('expired_at', String(Date.now() + 27 * 86400000));
  const accepted = await app.fetch(new Request('https://pb.example.test/', { method: 'POST', body: form }), env, ctx);
  await Promise.all(state.pending);
  assert.equal(accepted.status, 200);

  const excessive = new FormData();
  excessive.set('u', 'hello');
  excessive.set('expired_at', String(Date.now() + 29 * 86400000));
  const rejected = await app.fetch(new Request('https://pb.example.test/', { method: 'POST', body: excessive }), env, ctx);
  assert.equal(rejected.status, 422);
});

test('Oversize default upload returns 422 without calling S3', async () => {
  const form = new FormData();
  form.set('u', 'x'.repeat(101));
  const response = await app.fetch(new Request('https://pb.example.test/', { method: 'POST', body: form }), env, ctx);
  assert.equal(response.status, 422);
  assert.match(await response.text(), /100 bytes/);
  assert.equal(state.uploads, 0);
});

test('An expired descriptor returns 410 even if KV has not evicted it yet', async () => {
  state.entries.set('abcd', JSON.stringify({ uuid: 'abcd', paste_type: 2, expired_at: Date.now() - 1000 }));
  const response = await app.fetch(new Request('https://pb.example.test/abcd'), env, ctx);
  await Promise.all(state.pending);
  assert.equal(response.status, 410);
});

test('CORS patterns match only allowed web origins on simple and preflight requests', async () => {
  const cases = [
    { domains: ['*.nekoid.cc'], origin: 'https://app.nekoid.cc', allowed: true },
    { domains: ['*.nekoid.cc'], origin: 'https://deep.app.nekoid.cc:8443', allowed: true },
    { domains: ['*.nekoid.cc'], origin: 'https://nekoid.cc', allowed: false },
    { domains: ['*.nekoid.cc'], origin: 'https://badnekoid.cc', allowed: false },
    { domains: ['*.nekoid.cc'], origin: 'https://app.nekoid.cc.evil.test', allowed: false },
    { domains: ['http://127.0.0.1:*'], origin: 'http://127.0.0.1', allowed: true },
    { domains: ['http://127.0.0.1:*'], origin: 'http://127.0.0.1:3000', allowed: true },
    { domains: ['http://127.0.0.1:*'], origin: 'http://127.0.0.1:80', allowed: true },
    { domains: ['http://127.0.0.1:*'], origin: 'https://127.0.0.1:3000', allowed: false },
    { domains: ['http://127.0.0.1:*'], origin: 'http://127.0.0.2:3000', allowed: false },
    { domains: ['http://127.0.0.1:*'], origin: 'http://evil.test@127.0.0.1:3000', allowed: false },
    { domains: ['http://127.0.0.1:*'], origin: 'http://127.0.0.1:bad', allowed: false },
    { domains: ['http://127.0.0.1:*'], origin: 'http://127.0.0.1:3000/path', allowed: false },
    { domains: ['https://app.nekoid.cc:444'], origin: 'https://app.nekoid.cc:444', allowed: true },
    { domains: ['https://app.nekoid.cc:444'], origin: 'https://app.nekoid.cc:445', allowed: false },
    { domains: ['*'], origin: 'https://other.test:9000', allowed: true },
    { domains: ['*'], origin: 'null', allowed: false },
  ];

  for (const { domains, origin, allowed } of cases) {
    state.corsDomains = domains;
    for (const method of ['GET', 'OPTIONS']) {
      const response = await app.fetch(new Request('https://pb.example.test/no-such-paste', {
        method,
        headers: { Origin: origin },
      }), env, ctx);
      assert.equal(response.headers.get('access-control-allow-origin'), allowed ? origin : null, `${method} ${origin}`);
    }
  }

  state.corsDomains = ['*'];
  for (const method of ['GET', 'OPTIONS']) {
    const response = await app.fetch(new Request('https://pb.example.test/no-such-paste', { method }), env, ctx);
    assert.equal(response.headers.get('access-control-allow-origin'), null, `${method} without Origin`);
  }
});
