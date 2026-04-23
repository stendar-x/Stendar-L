import type { StendarApiClient } from '../client';

export class CommunityQueries {
  constructor(private readonly api: StendarApiClient) {}

  getFeatureLeaderboard(limit?: number): Promise<Record<string, unknown>> {
    if (limit !== undefined && (!Number.isFinite(limit) || limit < 1)) {
      throw new Error('Invalid limit: expected a positive finite number');
    }
    const query = typeof limit === 'number' ? `?limit=${Math.min(Math.floor(limit), 1000)}` : '';
    return this.api.get<Record<string, unknown>>(`/api/community/feature-requests/leaderboard${query}`);
  }
}
