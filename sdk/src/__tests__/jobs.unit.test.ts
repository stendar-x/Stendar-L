import assert from 'node:assert/strict';
import test from 'node:test';
import type { StendarApiClient } from '../client';
import { JobActions } from '../actions/jobs';

function createMockApiClient() {
  const calls: Array<{ method: 'get' | 'post'; path: string; body?: unknown }> = [];

  const api = {
    get: async <T>(path: string): Promise<T> => {
      calls.push({ method: 'get', path });
      return { ok: true, path } as T;
    },
    post: async <T>(path: string, body?: unknown): Promise<T> => {
      calls.push({ method: 'post', path, body });
      return { ok: true, path, body } as T;
    },
  } as unknown as StendarApiClient;

  return { api, calls };
}

test('jobs.submit calls POST /api/jobs', async () => {
  const { api, calls } = createMockApiClient();
  const jobs = new JobActions(api);

  await jobs.submit({ tool: 'create_loan', params: { amount: 100 } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'post');
  assert.equal(calls[0].path, '/api/jobs');
  assert.deepStrictEqual((calls[0].body as any).tool, 'create_loan');
});

test('jobs.getStatus calls GET /api/jobs/:id', async () => {
  const { api, calls } = createMockApiClient();
  const jobs = new JobActions(api);

  await jobs.getStatus('job-123');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'get');
  assert.equal(calls[0].path, '/api/jobs/job-123');
});

test('jobs.list calls GET /api/jobs with query params', async () => {
  const { api, calls } = createMockApiClient();
  const jobs = new JobActions(api);

  await jobs.list({ status: 'queued', tool: 'fund_loan', limit: 5 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'get');
  assert.ok(calls[0].path.includes('/api/jobs'));
  assert.ok(calls[0].path.includes('status=queued'));
  assert.ok(calls[0].path.includes('tool=fund_loan'));
  assert.ok(calls[0].path.includes('limit=5'));
});

test('jobs.cancel calls POST /api/jobs/:id/cancel', async () => {
  const { api, calls } = createMockApiClient();
  const jobs = new JobActions(api);

  await jobs.cancel('job-456');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'post');
  assert.equal(calls[0].path, '/api/jobs/job-456/cancel');
});

test('jobs.list with no params calls GET /api/jobs', async () => {
  const { api, calls } = createMockApiClient();
  const jobs = new JobActions(api);

  await jobs.list();
  assert.equal(calls[0].path, '/api/jobs');
});

test('jobs.list with array status', async () => {
  const { api, calls } = createMockApiClient();
  const jobs = new JobActions(api);

  await jobs.list({ status: ['queued', 'processing'] });
  assert.ok(calls[0].path.includes('status=queued'));
  assert.ok(calls[0].path.includes('status=processing'));
});
