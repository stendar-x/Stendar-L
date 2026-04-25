import type { StendarApiClient } from '../http-client';

export class MarketQueries {
  constructor(private readonly api: StendarApiClient) {}

  getSummary(): Promise<Record<string, unknown>> {
    return this.api.get<Record<string, unknown>>('/api/market/summary');
  }

  getRates(): Promise<Record<string, unknown>> {
    return this.api.get<Record<string, unknown>>('/api/market/rates');
  }
}
