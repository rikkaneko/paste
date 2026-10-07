const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const Module = require('node:module');

const projectRoot = join(__dirname, '..');
const outputDir = mkdtempSync(join(tmpdir(), 'paste-object-key-test-'));
execFileSync(join(projectRoot, 'node_modules/.bin/tsc'), ['--noEmit', 'false', '--outDir', outputDir, '--rootDir', 'src'], {
  cwd: projectRoot,
});

const state = { entries: new Map(), objectSizes: new Map(), signedCommands: [], headKeys: [], pending: [], basePath: undefined, nextUuid: 'abcd' };
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
class HeadObjectCommand {
  constructor(input) {
    this.input = input;
  }
}
class S3Client {
  async send(command) {
    if (command instanceof HeadObjectCommand) {
      state.headKeys.push(command.input.Key);
      const size = state.objectSizes.get(command.input.Key);
      return { $metadata: { httpStatusCode: size === undefined ? 404 : 200 }, ContentLength: size };
    }
    throw new Error('Unexpected S3 command');
  }
}
class Config {
  static get() {
    return new Config();
  }
  config() {
    return { uuid_length: 4, public_url: 'https://pb.example.test' };
  }
  filter_storage(name) {
    return name === 'default' ? {
      name: 'default',
      endpoint: 'https://storage.invalid',
      bucket_name: 'test-bucket',
      access_key_id: 'test-key',
      secret_access_key: 'test-secret',
      max_file_size: 100,
      base_path: state.basePath,
    } : null;
  }
}

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'itty-router/Router' || request === '@cesium133/forgjs' || request === 'js-sha256' || request === 'dedent-js') {
    return originalLoad(request, module, isMain);
  }
  if (request === '../config' || request === './config') return Config;
  if (request === '../utils') return {
    gen_id: () => state.nextUuid,
    get_auth: () => null,
    hexToBase64: () => 'test-checksum',
  };
  if (request === './auth') return {
    do_auth_v2: () => () => undefined,
    v2_token_check_scope: async () => false,
  };
  if (request === 'nanoid') return { customAlphabet: () => () => state.nextUuid };
  if (request === '@aws-sdk/client-s3') return { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand };
  if (request === '@aws-sdk/s3-request-presigner') return {
    getSignedUrl: async (client, command) => {
      state.signedCommands.push(command);
      return `https://storage.invalid/${encodeURIComponent(command.input.Key)}?sig=unchanged`;
    },
  };
  return originalLoad(request, parent, isMain);
};
const api = require(join(outputDir, 'v2/api.js')).default;
const { get_presign_url } = require(join(outputDir, 'utils.js'));
Module._load = originalLoad;

const env = {
  PASTE_INDEX: {
    get: async (key) => state.entries.get(key) ?? null,
    put: async (key, value) => state.entries.set(key, value),
  },
};
const ctx = { waitUntil: (promise) => state.pending.push(promise) };

test('v2 signed upload, completion, and download use each UUID object key', async () => {
  for (const basePath of [undefined, 'prefix/']) {
    state.entries.clear();
    state.objectSizes.clear();
    state.signedCommands = [];
    state.headKeys = [];
    state.pending = [];
    state.basePath = basePath;

    for (const uuid of ['abcd', 'efgh']) {
      state.nextUuid = uuid;
      const response = await api.fetch(new Request('https://pb.example.test/v2/create', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ file_size: 5, file_hash: 'a'.repeat(64), location: 'default' }),
      }), env, ctx);
      await Promise.all(state.pending);
      assert.equal(response.status, 200, await response.clone().text());
      const created = await response.json();
      const key = `${basePath ?? ''}${uuid}`;
      assert.equal(created.PasteCreateUploadResponse.uuid, uuid);
      assert.equal(created.PasteCreateUploadResponse.upload_url, `https://storage.invalid/${encodeURIComponent(key)}?sig=unchanged`);
      assert.equal(state.signedCommands.at(-1).input.Key, key);
      state.objectSizes.set(key, 5);
    }

    for (const uuid of ['abcd', 'efgh']) {
      const completed = await api.fetch(new Request(`https://pb.example.test/v2/complete/${uuid}`, { method: 'POST' }), env, ctx);
      await Promise.all(state.pending);
      assert.equal(completed.status, 200, await completed.clone().text());
      assert.equal((await completed.json()).PasteInfo.uuid, uuid);
      assert.equal(state.headKeys.at(-1), `${basePath ?? ''}${uuid}`);
    }

    const descriptor = JSON.parse(state.entries.get('efgh'));
    const downloadUrl = await get_presign_url('efgh', descriptor);
    assert.equal(downloadUrl, `https://storage.invalid/${encodeURIComponent(`${basePath ?? ''}efgh`)}?sig=unchanged`);
    assert.equal(state.signedCommands.at(-1).input.Key, `${basePath ?? ''}efgh`);
    assert.deepEqual(state.headKeys, [`${basePath ?? ''}abcd`, `${basePath ?? ''}efgh`]);
  }
});
