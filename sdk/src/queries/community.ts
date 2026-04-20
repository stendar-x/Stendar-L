import type { StendarApiClient } from '../client';

export class CommunityQueries {
  constructor(private readonly api: StendarApiClient) {}

  getFeatureLeaderboard(limit?: number): Promise<Record<string, unknown>> {
    const query = typeof limit === 'number' ? `?limit=${Math.max(1, Math.floor(limit))}` : '';
    return this.api.get<Record<string, unknown>>(`/api/community/feature-requests/leaderboard${query}`);
  }
}
