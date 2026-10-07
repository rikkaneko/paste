const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');

test('paste CLI reports HTTP error bodies and logs complete curl commands', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'paste-cli-test-'));
  const curlLog = join(tempDir, 'curl.log');
  const inputFile = join(tempDir, 'paste.txt');
  const cli = resolve(__dirname, '../client/paste-cli');

  // Route CLI requests to fixed responses so tests never contact the public service.
  writeFileSync(join(tempDir, 'curl'), `#!/bin/bash
printf '%s\\n' "$*" >> "$MOCK_CURL_LOG";
output_file='';
previous='';
method='';
auth_header='';
for arg in "$@"; do
  if [[ "$arg" == https://* ]]; then url="$arg"; fi;
  if [[ "$previous" == '-o' ]]; then output_file="$arg"; fi;
  if [[ "$previous" == '-X' ]]; then method="$arg"; fi;
  if [[ "$previous" == '-H' && "$arg" == Authorization:* ]]; then auth_header="$arg"; fi;
  previous="$arg";
done;
case "$url" in
  */v2/create)
    status="$MOCK_CREATE_STATUS";
    body='{"PasteCreateUploadResponse":{"uuid":"abcd","upload_url":"https://storage.invalid/object?X-Amz-SignedHeaders=host%3Bx-amz-checksum-sha256&X-Amz-Signature=secret-signature","request_headers":{"Content-Length":"5","x-amz-checksum-sha256":"hash="}}}';
    if [[ "$status" != 2* ]]; then body='{"message":"create rejected","details":{"reason":"denied"}}'; fi;
    ;;
  https://storage.invalid/object*)
    status="$MOCK_UPLOAD_STATUS";
    body='';
    if [[ "$status" != 2* ]]; then body='<Error><Code>SlowDown</Code><Message>storage rejected</Message></Error>'; fi;
    ;;
  */v2/complete/abcd)
    status="$MOCK_COMPLETE_STATUS";
    body='{"PasteInfo":{"uuid":"abcd","created_at":1700000000123,"expired_at":1700086400456}}';
    if [[ "$status" != 2* ]]; then body='{"message":"complete rejected","details":{"reason":"missing object"}}'; fi;
    ;;
  */v2/info/abcd)
    status="$MOCK_INFO_STATUS";
    body='{"PasteInfo":{"uuid":"abcd","created_at":1700000000123,"expired_at":1700086400456}}';
    if [[ "$status" != 2* ]]; then body='{"status_code":403,"message":"info rejected","details":{"scope":"paste"}}'; fi;
    ;;
  */v2/config)
    status="$MOCK_CONFIG_STATUS";
    body='{"Config":{}}';
    if [[ "$status" != 2* ]]; then body='{"status_code":403,"message":"config rejected","details":{"scope":"config"}}'; fi;
    ;;
  */v2/storage)
    status="$MOCK_STORAGE_STATUS";
    body='{"status_code":200,"Storages":[{"name":"default","max_file_size":1000}]}';
    if [[ "$auth_header" == 'Authorization: Bearer storage-token' ]]; then body='{"status_code":200,"Storages":[{"name":"default","max_file_size":1000},{"name":"private","max_file_size":2000,"protected":true}]}'; fi;
    if [[ "$status" != 2* ]]; then body='{"status_code":503,"message":"storage list unavailable"}'; fi;
    ;;
  */abcd)
    if [[ "$method" == DELETE ]]; then
      status="$MOCK_DELETE_STATUS";
      body='OK';
      if [[ "$status" != 2* ]]; then body='Incorrect password.'; fi;
    else
      status="$MOCK_DOWNLOAD_STATUS";
      body='hello';
      if [[ "$status" != 2* ]]; then body='Paste not found.'; fi;
    fi;
    ;;
  *) exit 1 ;;
esac;
if [[ -n "$output_file" ]]; then
  printf '%s' "$body" > "$output_file";
  printf '%s' "$status";
else
  printf '%s\\n%s' "$body" "$status";
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
      MOCK_INFO_STATUS: '200',
      MOCK_CONFIG_STATUS: '200',
      MOCK_DOWNLOAD_STATUS: '200',
      MOCK_DELETE_STATUS: '200',
      MOCK_STORAGE_STATUS: '200',
    };
    const uploadArgs = ['--endpoint', 'https://mock.invalid', 'upload', '--file', inputFile, '--mime_type', 'text/plain', '--password', 'upload-secret'];

    writeFileSync(curlLog, '');
    const created = spawnSync(cli, uploadArgs, { encoding: 'utf8', env: baseEnv });
    assert.equal(created.status, 0, created.stderr);
    assert.match(created.stdout, /"created_at": "2023-11-14T22:13:20\.123Z"/);
    assert.match(created.stdout, /"expired_at": "2023-11-15T22:13:20\.456Z"/);
    assert.equal(created.stderr.match(/^\[CURL\] curl .+$/gm).length, 3);
    assert.match(created.stderr, /\[CURL\] curl '-sS' '-w' .* '-X' 'POST' 'https:\/\/mock\.invalid\/v2\/create'/);
    assert.match(created.stderr, /'-d' .*upload-secret/);
    assert.match(created.stderr, /\[CURL\] curl .* '-X' 'PUT' .*'Content-Length: 5'.*'-T[^']*'.*secret-signature'/);
    assert.match(created.stderr, /\[CURL\] curl '-sS' '-w' .* '-X' 'POST' 'https:\/\/mock\.invalid\/v2\/complete\/abcd'/);
    assert.match(created.stderr, /'x-amz-checksum-sha256: hash='/);
    assert.match(created.stderr, /'https:\/\/storage\.invalid\/object\?X-Amz-SignedHeaders=host%3Bx-amz-checksum-sha256&X-Amz-Signature=secret-signature'/);
    assert.doesNotMatch(created.stderr, /\\&|\\ /);
    assert.doesNotMatch(created.stdout, /\[CURL\]|secret-signature|upload-secret/);
    assert.match(readFileSync(curlLog, 'utf8'), /v2\/complete\/abcd/);
    assert.match(readFileSync(curlLog, 'utf8'), /-H x-amz-checksum-sha256: hash=/);
    assert.match(readFileSync(curlLog, 'utf8'), /-H Content-Type: text\/plain -T/);
    assert.ok(readFileSync(curlLog, 'utf8').split('\n').some((line) => line.endsWith('https://storage.invalid/object?X-Amz-SignedHeaders=host%3Bx-amz-checksum-sha256&X-Amz-Signature=secret-signature')));

    for (const [value, milliseconds] of [
      ['1791387045123', 1791387045123],
      ['2026-01-01', 1767225600000],
      ['2026-10-07T15:30:45Z', 1791387045000],
      ['2026-10-07T15:30:45', 1791387045000],
      ['2026-10-07T23:30:45.123456+08:00', 1791387045123],
    ]) {
      writeFileSync(curlLog, '');
      const uploadWithExpiry = spawnSync(cli, [...uploadArgs, '--expired_at', value], { encoding: 'utf8', env: baseEnv });
      assert.equal(uploadWithExpiry.status, 0, uploadWithExpiry.stderr);
      assert.match(readFileSync(curlLog, 'utf8'), new RegExp(`"expired_at": ${milliseconds}`));
    }

    for (const value of ['2026-02-30', '2026-02-30T00:00:00Z', '2026-10-07T15:30:45+25:00', 'not-a-date', '123ms']) {
      writeFileSync(curlLog, '');
      const invalidExpiry = spawnSync(cli, [...uploadArgs, '--expired_at', value], { encoding: 'utf8', env: baseEnv });
      assert.notEqual(invalidExpiry.status, 0);
      assert.match(invalidExpiry.stderr, /Invalid --expired_at/);
      assert.equal(readFileSync(curlLog, 'utf8'), '');
    }
    const missingUploadExpiry = spawnSync(cli, [...uploadArgs, '--expired_at'], { encoding: 'utf8', env: baseEnv });
    assert.notEqual(missingUploadExpiry.status, 0);
    assert.match(missingUploadExpiry.stderr, /Missing value for --expired_at/);

    writeFileSync(curlLog, '');
    const createFailed = spawnSync(cli, uploadArgs, {
      encoding: 'utf8',
      env: { ...baseEnv, MOCK_CREATE_STATUS: '403' },
    });
    assert.notEqual(createFailed.status, 0);
    assert.match(createFailed.stderr, /HTTP 403 response:/);
    assert.match(createFailed.stderr, /\{"message":"create rejected","details":\{"reason":"denied"\}\}/);
    assert.equal(createFailed.stderr.match(/^\[CURL\] curl .+$/gm).length, 1);
    assert.doesNotMatch(readFileSync(curlLog, 'utf8'), /storage\.invalid/);

    writeFileSync(curlLog, '');
    const uploadFailed = spawnSync(cli, uploadArgs, {
      encoding: 'utf8',
      env: { ...baseEnv, MOCK_UPLOAD_STATUS: '503' },
    });
    assert.notEqual(uploadFailed.status, 0);
    assert.match(uploadFailed.stderr, /HTTP 503 response:/);
    assert.match(uploadFailed.stderr, /<Error><Code>SlowDown<\/Code><Message>storage rejected<\/Message><\/Error>/);
    assert.equal(uploadFailed.stderr.match(/^\[CURL\] curl .+$/gm).length, 2);
    assert.doesNotMatch(readFileSync(curlLog, 'utf8'), /v2\/complete/);

    const completeFailed = spawnSync(cli, uploadArgs, {
      encoding: 'utf8',
      env: { ...baseEnv, MOCK_COMPLETE_STATUS: '409' },
    });
    assert.notEqual(completeFailed.status, 0);
    assert.match(completeFailed.stderr, /HTTP 409 response:/);
    assert.match(completeFailed.stderr, /\{"message":"complete rejected","details":\{"reason":"missing object"\}\}/);
    assert.doesNotMatch(completeFailed.stdout, /Paste created successfully/);
    assert.equal(completeFailed.stderr.match(/^\[CURL\] curl .+$/gm).length, 3);

    writeFileSync(curlLog, '');
    const infoRead = spawnSync(cli, ['--endpoint', 'https://mock.invalid', 'info', 'abcd', '--auth-key', 'secret'], {
      encoding: 'utf8',
      env: baseEnv,
    });
    assert.equal(infoRead.status, 0, infoRead.stderr);
    assert.match(infoRead.stdout, /"created_at": "2023-11-14T22:13:20\.123Z"/);
    assert.match(infoRead.stdout, /"expired_at": "2023-11-15T22:13:20\.456Z"/);
    assert.match(readFileSync(curlLog, 'utf8'), /x-auth-key: secret/);
    assert.match(infoRead.stderr, /\[CURL\] curl '-sS' '-w' .* '-X' 'GET' '-H' 'x-auth-key: secret' 'https:\/\/mock\.invalid\/v2\/info\/abcd'/);
    assert.doesNotMatch(infoRead.stdout, /\[CURL\]|secret/);

    writeFileSync(curlLog, '');
    const specialAuth = "sp ace&'\"$HOME`literal";
    const specialRead = spawnSync(cli, ['--endpoint', 'https://mock.invalid', 'info', 'abcd', '--auth-key', specialAuth], {
      encoding: 'utf8',
      env: baseEnv,
    });
    assert.equal(specialRead.status, 0, specialRead.stderr);
    const loggedCommand = specialRead.stderr.split('\n').find((line) => line.startsWith('[CURL] curl ')).slice('[CURL] '.length);
    assert.match(loggedCommand, /'x-auth-key: sp ace&/);
    assert.ok(loggedCommand.includes("'\"'\"'"), loggedCommand);
    assert.doesNotMatch(loggedCommand, /\\&|\\ /);
    const originalCall = readFileSync(curlLog, 'utf8');
    const replayed = spawnSync('bash', ['-c', loggedCommand], { encoding: 'utf8', env: baseEnv });
    assert.equal(replayed.status, 0, replayed.stderr);
    assert.equal(readFileSync(curlLog, 'utf8'), originalCall.repeat(2));

    const infoReadFailed = spawnSync(cli, ['--endpoint', 'https://mock.invalid', 'info', 'abcd'], {
      encoding: 'utf8',
      env: { ...baseEnv, MOCK_INFO_STATUS: '403' },
    });
    assert.notEqual(infoReadFailed.status, 0);
    assert.match(infoReadFailed.stderr, /HTTP 403 response:/);
    assert.match(infoReadFailed.stderr, /\{"status_code":403,"message":"info rejected","details":\{"scope":"paste"\}\}/);

    const credentialEndpoint = spawnSync(cli, ['--endpoint', 'https://name:endpoint-secret@mock.invalid', 'info', 'abcd'], {
      encoding: 'utf8',
      env: baseEnv,
    });
    assert.equal(credentialEndpoint.status, 0, credentialEndpoint.stderr);
    assert.match(credentialEndpoint.stderr, /\[CURL\] curl '-sS' '-w' .* '-X' 'GET' 'https:\/\/name:endpoint-secret@mock\.invalid\/v2\/info\/abcd'/);
    assert.doesNotMatch(credentialEndpoint.stdout, /\[CURL\]|endpoint-secret/);

    writeFileSync(curlLog, '');
    const infoUpdated = spawnSync(cli, ['--endpoint', 'https://mock.invalid', 'info', 'abcd', '--auth-key', 'secret', '--title', 'new'], {
      encoding: 'utf8',
      env: baseEnv,
    });
    assert.equal(infoUpdated.status, 0, infoUpdated.stderr);
    assert.match(infoUpdated.stdout, /"created_at": "2023-11-14T22:13:20\.123Z"/);
    assert.match(readFileSync(curlLog, 'utf8'), /x-pass: secret/);
    assert.doesNotMatch(readFileSync(curlLog, 'utf8'), /Authorization: Bearer/);
    assert.match(infoUpdated.stderr, /\[CURL\] curl '-sS' '-w' .* '-X' 'POST' '-H' 'x-pass: secret' .* '-d' .* 'https:\/\/mock\.invalid\/v2\/info\/abcd'/);
    assert.doesNotMatch(infoUpdated.stdout, /\[CURL\]|secret/);

    for (const [value, milliseconds] of [
      ['1791387045123', 1791387045123],
      ['2026-10-08', 1791417600000],
      ['2026-10-07T15:30:45.123Z', 1791387045123],
      ['2026-10-07T10:00:45.123-05:30', 1791387045123],
    ]) {
      writeFileSync(curlLog, '');
      const infoWithExpiry = spawnSync(cli, ['--endpoint', 'https://mock.invalid', 'info', 'abcd', '--expired_at', value], {
        encoding: 'utf8',
        env: baseEnv,
      });
      assert.equal(infoWithExpiry.status, 0, infoWithExpiry.stderr);
      assert.match(readFileSync(curlLog, 'utf8'), new RegExp(`"expired_at": ${milliseconds}`));
    }

    writeFileSync(curlLog, '');
    const invalidInfoExpiry = spawnSync(cli, ['--endpoint', 'https://mock.invalid', 'info', 'abcd', '--expired_at', '2026-13-07T15:30:45Z'], {
      encoding: 'utf8',
      env: baseEnv,
    });
    assert.notEqual(invalidInfoExpiry.status, 0);
    assert.match(invalidInfoExpiry.stderr, /Invalid --expired_at/);
    assert.equal(readFileSync(curlLog, 'utf8'), '');
    const missingInfoExpiry = spawnSync(cli, ['--endpoint', 'https://mock.invalid', 'info', 'abcd', '--expired_at'], {
      encoding: 'utf8',
      env: baseEnv,
    });
    assert.notEqual(missingInfoExpiry.status, 0);
    assert.match(missingInfoExpiry.stderr, /Missing value for --expired_at/);
    assert.equal(readFileSync(curlLog, 'utf8'), '');

    const infoUpdateFailed = spawnSync(cli, ['--endpoint', 'https://mock.invalid', 'info', 'abcd', '--title', 'new'], {
      encoding: 'utf8',
      env: { ...baseEnv, MOCK_INFO_STATUS: '403' },
    });
    assert.notEqual(infoUpdateFailed.status, 0);
    assert.match(infoUpdateFailed.stderr, /\{"status_code":403,"message":"info rejected","details":\{"scope":"paste"\}\}/);

    const downloaded = spawnSync(cli, ['--endpoint', 'https://mock.invalid', 'get', 'abcd', '--auth-key', 'download-secret'], {
      encoding: 'utf8',
      env: baseEnv,
      cwd: tempDir,
    });
    assert.equal(downloaded.status, 0, downloaded.stderr);
    assert.equal(downloaded.stderr.match(/^\[CURL\] curl .+$/gm).length, 2);
    assert.match(downloaded.stderr, /\[CURL\] curl '-sS' '-w' .* '-H' 'x-auth-key: download-secret' 'https:\/\/mock\.invalid\/v2\/info\/abcd'/);
    assert.match(downloaded.stderr, /\[CURL\] curl '-sS' '-H' 'x-auth-key: download-secret' '-o' .* '-w' .* 'https:\/\/mock\.invalid\/abcd'/);
    assert.doesNotMatch(downloaded.stdout, /\[CURL\]|download-secret/);
    assert.equal(readFileSync(join(tempDir, 'abcd'), 'utf8'), 'hello');

    const metadataFailed = spawnSync(cli, ['--endpoint', 'https://mock.invalid', 'get', 'abcd'], {
      encoding: 'utf8',
      env: { ...baseEnv, MOCK_INFO_STATUS: '403' },
      cwd: tempDir,
    });
    assert.notEqual(metadataFailed.status, 0);
    assert.match(metadataFailed.stderr, /\{"status_code":403,"message":"info rejected","details":\{"scope":"paste"\}\}/);

    const existingFile = join(tempDir, 'existing.txt');
    writeFileSync(existingFile, 'keep this file');
    const downloadFailed = spawnSync(cli, ['--endpoint', 'https://mock.invalid', 'get', 'abcd', '-o', existingFile], {
      encoding: 'utf8',
      env: { ...baseEnv, MOCK_DOWNLOAD_STATUS: '404' },
    });
    assert.notEqual(downloadFailed.status, 0);
    assert.match(downloadFailed.stderr, /HTTP 404 response:/);
    assert.match(downloadFailed.stderr, /Paste not found\./);
    assert.equal(readFileSync(existingFile, 'utf8'), 'keep this file');

    const configRead = spawnSync(cli, ['--endpoint', 'https://mock.invalid', 'config', '--auth-token', 'admin-secret'], {
      encoding: 'utf8',
      env: baseEnv,
    });
    assert.equal(configRead.status, 0, configRead.stderr);
    assert.match(configRead.stderr, /\[CURL\] curl '-sS' '-w' .* '-X' 'GET' '-H' 'Authorization: Bearer admin-secret' 'https:\/\/mock\.invalid\/v2\/config'/);
    assert.doesNotMatch(configRead.stdout, /\[CURL\]|admin-secret/);

    const configReadFailed = spawnSync(cli, ['--endpoint', 'https://mock.invalid', 'config'], {
      encoding: 'utf8',
      env: { ...baseEnv, MOCK_CONFIG_STATUS: '403' },
    });
    assert.notEqual(configReadFailed.status, 0);
    assert.match(configReadFailed.stderr, /\{"status_code":403,"message":"config rejected","details":\{"scope":"config"\}\}/);

    const configFile = join(tempDir, 'config.json');
    writeFileSync(configFile, '{"config_auth_token":"config-secret"}');
    const configUpdated = spawnSync(cli, ['--endpoint', 'https://mock.invalid', 'config', '--auth-token', 'admin-secret', '--file', configFile], {
      encoding: 'utf8',
      env: baseEnv,
    });
    assert.equal(configUpdated.status, 0, configUpdated.stderr);
    assert.match(configUpdated.stderr, /\[CURL\] curl '-sS' '-w' .* '-X' 'POST' '-H' 'Authorization: Bearer admin-secret' .* '-d' '@.*config\.json' 'https:\/\/mock\.invalid\/v2\/config'/);
    assert.doesNotMatch(configUpdated.stdout, /\[CURL\]|admin-secret|config-secret/);

    const configUpdateFailed = spawnSync(cli, ['--endpoint', 'https://mock.invalid', 'config', '--file', configFile], {
      encoding: 'utf8',
      env: { ...baseEnv, MOCK_CONFIG_STATUS: '403' },
    });
    assert.notEqual(configUpdateFailed.status, 0);
    assert.match(configUpdateFailed.stderr, /\{"status_code":403,"message":"config rejected","details":\{"scope":"config"\}\}/);

    writeFileSync(curlLog, '');
    const deleted = spawnSync(cli, ['--endpoint', 'https://mock.invalid', 'delete', 'abcd'], {
      encoding: 'utf8',
      env: baseEnv,
    });
    assert.equal(deleted.status, 0, deleted.stderr);
    assert.match(deleted.stdout, /Paste abcd deleted\./);
    assert.match(deleted.stderr, /\[CURL\] curl '-sS' '-w' .* '-X' 'DELETE' 'https:\/\/mock\.invalid\/abcd'/);
    assert.doesNotMatch(readFileSync(curlLog, 'utf8'), /x-auth-key|Authorization:/);

    writeFileSync(curlLog, '');
    const protectedDeleted = spawnSync(cli, ['--endpoint', 'https://mock.invalid', 'delete', 'abcd', '--auth-key', 'delete-secret'], {
      encoding: 'utf8',
      env: baseEnv,
    });
    assert.equal(protectedDeleted.status, 0, protectedDeleted.stderr);
    assert.match(readFileSync(curlLog, 'utf8'), /-X DELETE -H x-auth-key: delete-secret https:\/\/mock\.invalid\/abcd/);
    assert.doesNotMatch(protectedDeleted.stdout, /delete-secret/);

    const deleteFailed = spawnSync(cli, ['--endpoint', 'https://mock.invalid', 'delete', 'abcd', '--auth-key', 'wrong'], {
      encoding: 'utf8',
      env: { ...baseEnv, MOCK_DELETE_STATUS: '403' },
    });
    assert.notEqual(deleteFailed.status, 0);
    assert.match(deleteFailed.stderr, /HTTP 403 response:[\s\S]*Incorrect password\./);
    assert.doesNotMatch(deleteFailed.stdout, /deleted\./);

    writeFileSync(curlLog, '');
    for (const args of [['delete'], ['delete', 'abcd', '--auth-key'], ['delete', 'abcd', '--unknown']]) {
      const invalid = spawnSync(cli, ['--endpoint', 'https://mock.invalid', ...args], { encoding: 'utf8', env: baseEnv });
      assert.notEqual(invalid.status, 0);
    }
    assert.equal(readFileSync(curlLog, 'utf8'), '');

    const publicStorages = spawnSync(cli, ['--endpoint', 'https://mock.invalid', 'list-storage'], {
      encoding: 'utf8',
      env: baseEnv,
    });
    assert.equal(publicStorages.status, 0, publicStorages.stderr);
    assert.deepEqual(JSON.parse(publicStorages.stdout), { status_code: 200, Storages: [{ name: 'default', max_file_size: 1000 }] });
    assert.match(publicStorages.stderr, /\[CURL\] curl '-sS' '-w' .* '-X' 'GET' 'https:\/\/mock\.invalid\/v2\/storage'/);

    writeFileSync(curlLog, '');
    const protectedStorages = spawnSync(cli, ['--endpoint', 'https://mock.invalid', 'list-storage', '--auth-token', 'storage-token'], {
      encoding: 'utf8',
      env: baseEnv,
    });
    assert.equal(protectedStorages.status, 0, protectedStorages.stderr);
    assert.equal(JSON.parse(protectedStorages.stdout).Storages[1].name, 'private');
    assert.match(readFileSync(curlLog, 'utf8'), /-X GET -H Authorization: Bearer storage-token https:\/\/mock\.invalid\/v2\/storage/);
    assert.doesNotMatch(protectedStorages.stdout, /storage-token/);

    const storageFailed = spawnSync(cli, ['--endpoint', 'https://mock.invalid', 'list-storage'], {
      encoding: 'utf8',
      env: { ...baseEnv, MOCK_STORAGE_STATUS: '503' },
    });
    assert.notEqual(storageFailed.status, 0);
    assert.match(storageFailed.stderr, /HTTP 503 response:[\s\S]*storage list unavailable/);

    writeFileSync(curlLog, '');
    for (const args of [['list-storage', '--auth-token'], ['list-storage', '--unknown']]) {
      const invalid = spawnSync(cli, ['--endpoint', 'https://mock.invalid', ...args], { encoding: 'utf8', env: baseEnv });
      assert.notEqual(invalid.status, 0);
    }
    for (const command of ['delete', 'list-storage']) {
      const help = spawnSync(cli, [command, '--help'], { encoding: 'utf8', env: baseEnv });
      assert.equal(help.status, 0, help.stderr);
      assert.match(help.stdout, new RegExp(`Usage: ${command}`));
    }
    const globalHelp = spawnSync(cli, ['--help'], { encoding: 'utf8', env: baseEnv });
    assert.match(globalHelp.stdout, /delete[\s\S]*list-storage/);
    assert.equal(readFileSync(curlLog, 'utf8'), '');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
