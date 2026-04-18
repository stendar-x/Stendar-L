import type { StendarApiClient } from '../client';
import type {
  JobCancelResponse,
  JobListQuery,
  JobListResponse,
  JobStatusResponse,
  JobSubmissionRequest,
  JobSubmissionResponse,
} from '../types';

export class JobActions {
  constructor(private readonly api: StendarApiClient) {}

  submit(request: JobSubmissionRequest): Promise<JobSubmissionResponse> {
    return this.api.post<JobSubmissionResponse>('/api/jobs', request);
  }

  getStatus(jobId: string): Promise<JobStatusResponse> {
    return this.api.get<JobStatusResponse>(`/api/jobs/${encodeURIComponent(jobId)}`);
  }

  list(query: JobListQuery = {}): Promise<JobListResponse> {
    const params = new URLSearchParams();
    if (query.status) {
      const statuses = Array.isArray(query.status) ? query.status : [query.status];
      for (const s of statuses) params.append('status', s);
    }
    if (query.tool) params.set('tool', query.tool);
    if (query.limit) params.set('limit', String(query.limit));
    if (query.cursor) params.set('cursor', query.cursor);
    const qs = params.toString();
    return this.api.get<JobListResponse>(`/api/jobs${qs ? `?${qs}` : ''}`);
  }

  cancel(jobId: string): Promise<JobCancelResponse> {
    return this.api.post<JobCancelResponse>(`/api/jobs/${encodeURIComponent(jobId)}/cancel`);
  }

  async poll(
    jobId: string,
    opts: { intervalMs?: number; timeoutMs?: number } = {}
  ): Promise<JobStatusResponse> {
    const intervalMs = Math.max(500, opts.intervalMs ?? 2_000);
    const timeoutMs = opts.timeoutMs ?? 120_000;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const status = await this.getStatus(jobId);
      if (status.status === 'completed' || status.status === 'failed' || status.status === 'cancelled') {
        return status;
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    throw new Error(`Job ${jobId} did not complete within ${timeoutMs}ms`);
  }
}
