import type { StendarApiClient } from '../client';
import type {
  BugReportRequest,
  FeatureRequestSubmissionRequest,
  SupportMessageRequest,
} from '../types';

export class CommunityActions {
  constructor(private readonly api: StendarApiClient) {}

  submitSupport(request: SupportMessageRequest): Promise<Record<string, unknown>> {
    return this.api.post<Record<string, unknown>>('/api/community/support', request);
  }

  submitBugReport(request: BugReportRequest): Promise<Record<string, unknown>> {
    return this.api.post<Record<string, unknown>>('/api/community/bug-reports', request);
  }

  submitFeatureRequest(request: FeatureRequestSubmissionRequest): Promise<Record<string, unknown>> {
    return this.api.post<Record<string, unknown>>('/api/community/feature-requests', request);
  }
}
