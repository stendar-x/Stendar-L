import assert from 'node:assert/strict';
import test from 'node:test';
import { assertApiUrlSecurity, StendarApiClient } from '../http-client';

function mockFetch(): typeof globalThis.fetch {
  return (async () => {
    throw new Error('fetch should not be called in constructor tests');
  }) as typeof globalThis.fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
    },
  });
}

test('assertApiUrlSecurity rejects http:// URLs in production', () => {
  assert.throws(
    () => assertApiUrlSecurity('http://api.stendar.local', 'production'),
    /Insecure apiUrl "http:\/\/"/
  );
  assert.throws(
    () => assertApiUrlSecurity('http://api.stendar.local', 'prod'),
    /Insecure apiUrl "http:\/\/"/
  );
  assert.throws(
    () => assertApiUrlSecurity('http://api.stendar.local', 'PrOdUcTiOn'),
    /Insecure apiUrl "http:\/\/"/
  );
});

test('assertApiUrlSecurity allows http:// outside production and allows https:// in production', () => {
  assert.doesNotThrow(() => assertApiUrlSecurity('http://localhost:8787', 'development'));
  assert.doesNotThrow(() => assertApiUrlSecurity('https://api.stendar.xyz', 'production'));
});

test('StendarApiClient constructor enforces https in production', () => {
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    assert.throws(
      () =>
        new StendarApiClient({
          apiUrl: 'http://api.stendar.local',
          fetch: mockFetch(),
        }),
      /Insecure apiUrl "http:\/\/"/
    );
    assert.doesNotThrow(
      () =>
        new StendarApiClient({
          apiUrl: 'https://api.stendar.xyz',
          fetch: mockFetch(),
        })
    );
  } finally {
    process.env.NODE_ENV = previousNodeEnv;
  }
});

test('StendarApiClient rejects absolute URL request paths', async () => {
  let calls = 0;
  const client = new StendarApiClient({
    apiUrl: 'https://api.stendar.xyz',
    fetch: (async () => {
      calls += 1;
      return jsonResponse({ success: true, data: { ok: true } });
    }) as typeof globalThis.fetch,
  });

  await assert.rejects(
    () => client.get('https://attacker.com/steal'),
    /Absolute URLs are not allowed/i
  );
  await assert.rejects(
    () => client.get('http://attacker.com/steal'),
    /Absolute URLs are not allowed/i
  );
  await assert.rejects(
    () => client.get('ftp://attacker.com/steal'),
    /Absolute URLs are not allowed/i
  );
  assert.equal(calls, 0);
});

test('StendarApiClient accepts relative request paths', async () => {
  const urls: string[] = [];
  const client = new StendarApiClient({
    apiUrl: 'https://api.stendar.xyz',
    fetch: (async (input) => {
      urls.push(String(input));
      return jsonResponse({ success: true, data: { ok: true } });
    }) as typeof globalThis.fetch,
  });

  await client.get('/api/contracts');
  await client.get('api/contracts');

  assert.deepEqual(urls, [
    'https://api.stendar.xyz/api/contracts',
    'https://api.stendar.xyz/api/contracts',
  ]);
});

test('StendarApiClient retries retryable status codes with exponential backoff', async () => {
  let attempt = 0;
  const client = new StendarApiClient({
    apiUrl: 'https://api.stendar.xyz',
    maxRetries: 2,
    retryBackoffMs: 1,
    fetch: (async () => {
      attempt += 1;
      if (attempt < 3) {
        return jsonResponse({ success: false, error: { code: 'HTTP_503', message: 'Unavailable' } }, 503);
      }
      return jsonResponse({ success: true, data: { ok: true } });
    }) as typeof globalThis.fetch,
  });

  const response = await client.get<{ ok: boolean }>('/api/health');
  assert.equal(response.ok, true);
  assert.equal(attempt, 3);
});

test('StendarApiClient can skip auth headers per request', async () => {
  const headersSeen: Array<Record<string, string>> = [];
  const client = new StendarApiClient({
    apiUrl: 'https://api.stendar.xyz',
    apiKey: 'api-key',
    sessionBearerToken: 'session-token',
    fetch: (async (_input, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      headersSeen.push({
        ...(headers as Record<string, string>),
      });
      return jsonResponse({ success: true, data: { ok: true } });
    }) as typeof globalThis.fetch,
  });

  await client.get('/api/private');
  await client.get('/api/public', { requiresAuth: false });

  assert.equal(headersSeen[0]['X-API-Key'], undefined);
  assert.equal(headersSeen[0].Authorization, 'Bearer session-token');
  assert.equal(headersSeen[1]['X-API-Key'], undefined);
  assert.equal(headersSeen[1].Authorization, undefined);
});

test('StendarApiClient falls back to API key when session token is missing', async () => {
  const headersSeen: Array<Record<string, string>> = [];
  const client = new StendarApiClient({
    apiUrl: 'https://api.stendar.xyz',
    apiKey: 'api-key-only',
    fetch: (async (_input, init) => {
      headersSeen.push({ ...((init?.headers ?? {}) as Record<string, string>) });
      return jsonResponse({ success: true, data: { ok: true } });
    }) as typeof globalThis.fetch,
  });

  await client.get('/api/private');

  assert.equal(headersSeen[0]['X-API-Key'], 'api-key-only');
  assert.equal(headersSeen[0].Authorization, undefined);
});

test('StendarApiClient preserves explicit null envelope data', async () => {
  const client = new StendarApiClient({
    apiUrl: 'https://api.stendar.xyz',
    fetch: (async () => jsonResponse({ success: true, data: null })) as typeof globalThis.fetch,
  });

  const response = await client.get<null>('/api/null-data');
  assert.equal(response, null);
});

test('StendarApiClient treats success payloads without data/error as raw bodies', async () => {
  const client = new StendarApiClient({
    apiUrl: 'https://api.stendar.xyz',
    fetch: (async () => jsonResponse({ success: true })) as typeof globalThis.fetch,
  });

  const response = await client.get<unknown>('/api/missing-data');
  assert.deepEqual(response, { success: true });
});
