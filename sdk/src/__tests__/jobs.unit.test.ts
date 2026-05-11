import assert from 'node:assert/strict';
import test from 'node:test';
import type { StendarApiClient } from '../http-client';
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

test('jobs.poll enforces a minimum polling interval of 500ms', async () => {
  const statuses = [{ status: 'processing' }, { status: 'completed' }];
  let statusIndex = 0;
  const observedDelays: number[] = [];

  const originalSetTimeout = global.setTimeout;
  (global as unknown as { setTimeout: typeof setTimeout }).setTimeout = ((callback: (...args: unknown[]) => void, ms?: number) => {
    observedDelays.push(Number(ms ?? 0));
    callback();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;

  try {
    const api = {
      get: async <T>(): Promise<T> => {
        const status = statuses[Math.min(statusIndex, statuses.length - 1)];
        statusIndex += 1;
        return {
          jobId: 'job-1',
          tool: 'test',
          createdAt: 0,
          updatedAt: 0,
          attempts: 1,
          ...status,
        } as T;
      },
      post: async <T>(): Promise<T> => {
        throw new Error('not used');
      },
    } as unknown as StendarApiClient;

    const jobs = new JobActions(api);
    const result = await jobs.poll('job-1', { intervalMs: 0, timeoutMs: 5_000 });

    assert.equal(result.status, 'completed');
    assert.equal(observedDelays[0], 500);
  } finally {
    (global as unknown as { setTimeout: typeof setTimeout }).setTimeout = originalSetTimeout;
  }
});
