/**
 * Stdio MCPL children must not inherit the host's secrets. They get a small
 * operating allowlist (PATH, HOME, LC_*, ...) plus their declared `env`;
 * `inheritEnv: true` restores full inheritance.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildChildEnv, StdioTransport } from '../src/mcpl/transport.js';

const HOST_ENV = {
  PATH: '/usr/bin:/bin',
  HOME: '/home/resident',
  LANG: 'en_US.UTF-8',
  LC_CTYPE: 'UTF-8',
  TMPDIR: '/tmp/x',
  ANTHROPIC_AUTH_TOKEN: 'host-anthropic-secret',
  DISCORD_TOKEN: 'host-discord-secret',
  OPENAI_API_KEY: 'host-openai-secret',
};

test('drops host secrets, keeps operating vars and LC_*', () => {
  const env = buildChildEnv({}, HOST_ENV);
  assert.deepEqual(env, {
    PATH: '/usr/bin:/bin',
    HOME: '/home/resident',
    LANG: 'en_US.UTF-8',
    LC_CTYPE: 'UTF-8',
    TMPDIR: '/tmp/x',
  });
});

test('keeps CA bundles and uppercase/lowercase proxy configuration', () => {
  const networkEnv = {
    REQUESTS_CA_BUNDLE: '/etc/ssl/certs/internal.pem',
    CURL_CA_BUNDLE: '/etc/ssl/certs/curl.pem',
    HTTP_PROXY: 'http://user:password@proxy.example:8080',
    HTTPS_PROXY: 'http://proxy.example:8443',
    NO_PROXY: 'localhost,127.0.0.1,.internal',
    http_proxy: 'http://lowercase.example:8080',
    https_proxy: 'http://lowercase.example:8443',
    no_proxy: 'localhost,.lowercase.internal',
  };
  const env = buildChildEnv({}, { ...HOST_ENV, ...networkEnv });
  for (const [key, value] of Object.entries(networkEnv)) {
    assert.equal(env[key], value, key);
  }
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.DISCORD_TOKEN, undefined);
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
});

test('declared network settings override the host and empty values are preserved', () => {
  const env = buildChildEnv(
    { env: { REQUESTS_CA_BUNDLE: '/server/ca.pem', HTTPS_PROXY: '', NO_PROXY: '*' } },
    { REQUESTS_CA_BUNDLE: '/host/ca.pem', HTTPS_PROXY: 'http://proxy.example', NO_PROXY: '', http_proxy: '', CURL_CA_BUNDLE: undefined },
  );
  assert.deepEqual(env, {
    REQUESTS_CA_BUNDLE: '/server/ca.pem',
    HTTPS_PROXY: '',
    NO_PROXY: '*',
    http_proxy: '',
  });
});

test('declared env is passed through and wins over allowlisted host vars', () => {
  const env = buildChildEnv(
    { env: { DISCORD_TOKEN: 'declared-token', PATH: '/opt/bin' } },
    HOST_ENV,
  );
  assert.equal(env.DISCORD_TOKEN, 'declared-token');
  assert.equal(env.PATH, '/opt/bin');
  assert.equal(env.HOME, '/home/resident');
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
});

test('inheritEnv: true passes the whole host env, declared env on top', () => {
  const env = buildChildEnv({ inheritEnv: true, env: { EXTRA: '1' } }, HOST_ENV);
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'host-anthropic-secret');
  assert.equal(env.EXTRA, '1');
});

test('a real spawned stdio child sees only allowlist + declared env', async () => {
  const secretKey = 'MCPL_ENV_TEST_HOST_SECRET';
  const previousCaBundle = process.env.REQUESTS_CA_BUNDLE;
  const previousProxy = process.env.HTTPS_PROXY;
  process.env[secretKey] = 'must-not-leak';
  process.env.REQUESTS_CA_BUNDLE = '/host/internal-ca.pem';
  process.env.HTTPS_PROXY = 'http://proxy.example:8443';
  try {
    const transport = StdioTransport.spawn({
      id: 'env-probe',
      command: process.execPath,
      args: ['-e', 'console.log(JSON.stringify(process.env))'],
      env: { DECLARED_VAR: 'declared-value' },
    });
    const line = await new Promise<string>((resolve, reject) => {
      transport.once('line', resolve);
      transport.once('error', reject);
    });
    await transport.close();
    const childEnv = JSON.parse(line) as Record<string, string>;
    assert.equal(childEnv[secretKey], undefined);
    assert.equal(childEnv.DECLARED_VAR, 'declared-value');
    assert.equal(childEnv.REQUESTS_CA_BUNDLE, '/host/internal-ca.pem');
    assert.equal(childEnv.HTTPS_PROXY, 'http://proxy.example:8443');
    if (process.env.PATH) assert.equal(childEnv.PATH, process.env.PATH);
    if (process.env.HOME) assert.equal(childEnv.HOME, process.env.HOME);
  } finally {
    delete process.env[secretKey];
    if (previousCaBundle === undefined) delete process.env.REQUESTS_CA_BUNDLE;
    else process.env.REQUESTS_CA_BUNDLE = previousCaBundle;
    if (previousProxy === undefined) delete process.env.HTTPS_PROXY;
    else process.env.HTTPS_PROXY = previousProxy;
  }
});
