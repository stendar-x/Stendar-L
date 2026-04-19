import type { StendarApiClient } from '../client';
import type {
  BorrowerGuidance,
  BorrowerGuidanceQuery,
  DashboardData,
  RateBenchmark,
  RateBenchmarkQuery,
  SellerGuidance,
  SellerGuidanceQuery,
} from '../types';

function toQueryString<T extends object>(params: T): string {
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) {
      continue;
    }
    searchParams.append(key, String(value));
  }
  const serialized = searchParams.toString();
  return serialized ? `?${serialized}` : '';
}

export class RatesQueries {
  constructor(private readonly api: StendarApiClient) {}

  getBenchmark(params: RateBenchmarkQuery = {}): Promise<RateBenchmark> {
    return this.api.get<RateBenchmark>(`/api/rates/benchmark${toQueryString(params)}`);
  }

  getBorrowerGuidance(params: BorrowerGuidanceQuery): Promise<BorrowerGuidance> {
    return this.api.get<BorrowerGuidance>(`/api/rates/guidance/borrower${toQueryString(params)}`);
  }

  getSellerGuidance(params: SellerGuidanceQuery): Promise<SellerGuidance> {
    return this.api.get<SellerGuidance>(`/api/rates/guidance/seller${toQueryString(params)}`);
  }

  getDashboard(): Promise<DashboardData> {
    return this.api.get<DashboardData>('/api/rates/dashboard');
  }
}
