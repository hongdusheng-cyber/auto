import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { contractIdTextPattern, normalizeContractId, parseProxyValue, renderMagicConfig } from '../scripts/magic-config.mjs';

const runFile = promisify(execFile);
const template = [
  'proxies:',
  '  - name: example',
  '    type: socks5',
  '    server: old.example',
  "    port: '80'",
  "    username: 'old-user'",
  "    password: 'old-password'",
  'rules:',
  '  - MATCH,example',
  '',
].join('\n');

test('proxy parsing preserves colons in passwords and supports bracketed IPv6', () => {
  assert.deepEqual(parseProxyValue('proxy.example:62001:demo:part1:part2:part3'), {
    server: 'proxy.example', port: '62001', username: 'demo', password: 'part1:part2:part3',
  });
  assert.equal(parseProxyValue('[2001:db8::1]:1080:demo:password').server, '2001:db8::1');
});

test('invalid ports, missing fields, and control characters fail before browser work', () => {
  for (const port of ['0', '65536', '-1', '1.5', 'abc', '1e3']) {
    assert.throws(() => parseProxyValue(`proxy.example:${port}:demo:password`), /端口/);
  }
  for (const value of [
    'proxy.example:80:demo', 'proxy.example:80:demo:', 'proxy.example:80: :password',
    'proxy.example:80:demo:password\ninjected: true', 'proxy.example:80:demo:password\r',
    'proxy.example:80:demo:password\u0000',
  ]) {
    assert.throws(() => parseProxyValue(value), /代理参数/);
  }
});

test('YAML rendering retains punctuation and replacement tokens literally', () => {
  const proxy = parseProxyValue("proxy.example:1080:user'name:$&:$':$`:$1:pass'word #yes");
  const result = renderMagicConfig(template, proxy);
  assert.ok(result.includes("    username: 'user''name'\n"));
  assert.ok(result.includes("    password: '$&:$'':$`:$1:pass''word #yes'\n"));
  assert.ok(result.includes("    server: 'proxy.example'\n"));
  assert.ok(result.includes("    port: '1080'\n"));
  assert.ok(result.endsWith('rules:\n  - MATCH,example\n'));
  assert.ok(!result.includes('old-password'));
});

test('oversized proxy values cannot produce oversized configuration events', () => {
  assert.throws(() => parseProxyValue(`proxy.example:80:demo:${'x'.repeat(4096)}`), /4096/);
  const proxy = parseProxyValue('proxy.example:80:demo:password');
  assert.throws(() => renderMagicConfig(template, { ...proxy, password: 'x'.repeat(4096) }), /4096/);
});

test('YAML rendering preserves CRLF and rejects ambiguous or incomplete templates', () => {
  const proxy = parseProxyValue('proxy.example:80:demo:password');
  const result = renderMagicConfig(template.replaceAll('\n', '\r\n'), proxy);
  assert.ok(result.includes("    password: 'password'\r\n"));
  assert.throws(() => renderMagicConfig(template.replace(/^.*password.*\n/m, ''), proxy), /password/);
  assert.throws(() => renderMagicConfig(`${template}password: duplicate\n`, proxy), /password/);
  assert.throws(() => renderMagicConfig(template, { ...proxy, password: 'line1\nline2' }), /控制字符/);
});

test('contract IDs cannot escape their backup directory', () => {
  assert.equal(normalizeContractId('  svc_123-abc  '), 'svc_123-abc');
  for (const value of ['../outside', 'a/../../outside', '', null, 'a b', 'a\nb']) {
    assert.throws(() => normalizeContractId(value), /合约 ID 格式无效/);
  }
});

test('contract row matching distinguishes full IDs from prefixes and other row content', () => {
  const pattern = contractIdTextPattern('856');
  for (const text of ['856', 'ID: 856', 'ID：856', '合约 ID: 856']) {
    assert.equal(pattern.test(text), true, text);
  }
  for (const text of ['1856', '8560', 'ID: 1856', 'company856', '合约 1856，带宽 856M']) {
    assert.equal(pattern.test(text), false, text);
  }
  assert.equal(contractIdTextPattern('svc_A').test('svc_a'), false);
});

test('contract CLI validates the ID even in parse-only mode', async () => {
  await assert.rejects(runFile(process.execPath, [
    fileURLToPath(new URL('../scripts/open-contract.mjs', import.meta.url)),
    '--contract-id', '../outside', '--dry-run-parse',
  ]), (error) => error.code === 1 && /合约 ID 格式无效/.test(error.stderr));
});
