const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');

test('paste CLI upload status, auth header, and displayed timestamps', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'paste-cli-test-'));
  const curlLog = join(tempDir, 'curl.log');
  const inputFile = join(tempDir, 'paste.txt');
  const cli = resolve(__dirname, '../client/paste-cli');

  // Route CLI requests to fixed responses so tests never contact the public service.
  writeFileSync(join(tempDir, 'curl'), `#!/bin/bash
printf '%s\\n' "$*" >> "$MOCK_CURL_LOG";
for arg in "$@"; do
  if [[ "$arg" == https://* ]]; then url="$arg"; fi;
done;
case "$url" in
  */v2/create)
    status="$MOCK_CREATE_STATUS";
    body='{"PasteCreateUploadResponse":{"uuid":"abcd","upload_url":"https://storage.invalid/object","request_headers":{"Content-Length":"5","x-amz-checksum-sha256":"hash"}}}';
    if [[ "$status" != 2* ]]; then body='{"message":"create rejected"}'; fi;
    ;;
  https://storage.invalid/object)
    status="$MOCK_UPLOAD_STATUS";
    body='';
    ;;
  */v2/complete/abcd)
    status="$MOCK_COMPLETE_STATUS";
    body='{"PasteInfo":{"uuid":"abcd","created_at":1700000000123,"expired_at":1700086400456}}';
    if [[ "$status" != 2* ]]; then body='{"message":"complete rejected"}'; fi;
    ;;
  */v2/info/abcd)
    status=200;
    body='{"PasteInfo":{"uuid":"abcd","created_at":1700000000123,"expired_at":1700086400456}}';
    ;;
  *) exit 1 ;;
esac;
if [[ "$*" == *'-o /dev/null'* ]]; then
  printf '%s' "$status";
elif [[ "$*" == *'-w '* ]]; then
  printf '%s\\n%s' "$body" "$status";
else
  printf '%s' "$body";
fi;
`, { mode: 0o755 });
  writeFileSync(inputFile, 'hello');

  try {
    const baseEnv = {
      ...process.env,
      PATH: `${tempDir}:${process.env.PATH}`,
      MOCK_CURL_LOG: curlLog,
      MOCK_CREATE_STATUS: '200',
      MOCK_UPLOAD_STATUS: '200',
      MOCK_COMPLETE_STATUS: '200',
    };
    const uploadArgs = ['--endpoint', 'https://mock.invalid', 'upload', '--file', inputFile, '--mime_type', 'text/plain'];

    writeFileSync(curlLog, '');
    const created = spawnSync(cli, uploadArgs, { encoding: 'utf8', env: baseEnv });
    assert.equal(created.status, 0, created.stderr);
    assert.match(created.stdout, /"created_at": "2023-11-14T22:13:20\.123Z"/);
    assert.match(created.stdout, /"expired_at": "2023-11-15T22:13:20\.456Z"/);
    assert.match(readFileSync(curlLog, 'utf8'), /v2\/complete\/abcd/);

    writeFileSync(curlLog, '');
    const createFailed = spawnSync(cli, uploadArgs, {
      encoding: 'utf8',
      env: { ...baseEnv, MOCK_CREATE_STATUS: '403' },
    });
    assert.notEqual(createFailed.status, 0);
    assert.match(createFailed.stderr, /Create failed with HTTP 403: create rejected/);
    assert.doesNotMatch(readFileSync(curlLog, 'utf8'), /storage\.invalid/);

    writeFileSync(curlLog, '');
    const uploadFailed = spawnSync(cli, uploadArgs, {
      encoding: 'utf8',
      env: { ...baseEnv, MOCK_UPLOAD_STATUS: '503' },
    });
    assert.notEqual(uploadFailed.status, 0);
    assert.match(uploadFailed.stderr, /Storage upload failed with HTTP 503/);
    assert.doesNotMatch(readFileSync(curlLog, 'utf8'), /v2\/complete/);

    const completeFailed = spawnSync(cli, uploadArgs, {
      encoding: 'utf8',
      env: { ...baseEnv, MOCK_COMPLETE_STATUS: '409' },
    });
    assert.notEqual(completeFailed.status, 0);
    assert.match(completeFailed.stderr, /Finalization failed with HTTP 409: complete rejected/);
    assert.doesNotMatch(completeFailed.stdout, /Paste created successfully/);

    writeFileSync(curlLog, '');
    const infoRead = spawnSync(cli, ['--endpoint', 'https://mock.invalid', 'info', 'abcd', '--auth-key', 'secret'], {
      encoding: 'utf8',
      env: baseEnv,
    });
    assert.equal(infoRead.status, 0, infoRead.stderr);
    assert.match(infoRead.stdout, /"created_at": "2023-11-14T22:13:20\.123Z"/);
    assert.match(infoRead.stdout, /"expired_at": "2023-11-15T22:13:20\.456Z"/);
    assert.match(readFileSync(curlLog, 'utf8'), /x-auth-key: secret/);

    writeFileSync(curlLog, '');
    const infoUpdated = spawnSync(cli, ['--endpoint', 'https://mock.invalid', 'info', 'abcd', '--auth-key', 'secret', '--title', 'new'], {
      encoding: 'utf8',
      env: baseEnv,
    });
    assert.equal(infoUpdated.status, 0, infoUpdated.stderr);
    assert.match(infoUpdated.stdout, /"created_at": "2023-11-14T22:13:20\.123Z"/);
    assert.match(readFileSync(curlLog, 'utf8'), /x-pass: secret/);
    assert.doesNotMatch(readFileSync(curlLog, 'utf8'), /Authorization: Bearer/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
