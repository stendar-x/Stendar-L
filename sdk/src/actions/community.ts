import type { StendarApiClient } from '../client';
import type {
  BugReportRequest,
  FeatureRequestModerationStatus,
  FeatureRequestRecord,
  FeatureRequestSubmissionRequest,
  PoolOperatorApplicationRequest,
  PoolOperatorApplicationResponse,
  SupportMessageRequest,
} from '../types';
import { validatePathSegment } from '../utils/validation';

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

  listAdminFeatureRequests(status: FeatureRequestModerationStatus): Promise<FeatureRequestRecord[]> {
    return this.api.post<FeatureRequestRecord[]>(
      '/api/community/admin/feature-requests/list',
      { status }
    );
  }

  moderateFeatureRequest(
    featureRequestId: number,
    status: 'approved' | 'denied',
    moderationNotes?: string
  ): Promise<FeatureRequestRecord> {
    if (!Number.isInteger(featureRequestId) || featureRequestId <= 0) {
      throw new Error('Invalid featureRequestId: expected a positive integer');
    }

    const normalizedFeatureRequestId = validatePathSegment(
      String(featureRequestId),
      'featureRequestId'
    );
    const payload = moderationNotes === undefined ? { status } : { status, moderationNotes };

    return this.api.post<FeatureRequestRecord>(
      `/api/community/admin/feature-requests/${normalizedFeatureRequestId}/moderate`,
      payload
    );
  }

  applyPoolOperator(
    payload: PoolOperatorApplicationRequest
  ): Promise<PoolOperatorApplicationResponse> {
    return this.api.post<PoolOperatorApplicationResponse>(
      '/api/community/pool-operator-applications',
      payload
    );
  }
}
