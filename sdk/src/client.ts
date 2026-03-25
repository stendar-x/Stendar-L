import { CommunityActions } from './actions/community';
import { JobActions } from './actions/jobs';
import { LendingActions } from './actions/lending';
import { ProposalActions } from './actions/proposals';
import { TradingActions } from './actions/trading';
import { StendarProgramClient } from './program';
import { CollateralQueries } from './queries/collateral';
import { CommunityQueries } from './queries/community';
import { ContractsQueries } from './queries/contracts';
import { MarketQueries } from './queries/market';
import { PlatformQueries } from './queries/platform';
import { ProposalQueries } from './queries/proposals';
import { TradingQueries } from './queries/trading';
import { WalletQueries } from './queries/wallet';
import { HttpClientConfig, StendarApiError, StendarClientConfig, StendarClientMode } from './types';

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

function resolveApiUrl(configuredApiUrl?: string): string {
  const envApiUrl = process.env.STENDAR_API_URL;
  const resolvedApiUrl = configuredApiUrl || envApiUrl;
  if (!resolvedApiUrl || resolvedApiUrl.trim().length === 0) {
    throw new Error('apiUrl is required. Pass apiUrl or set STENDAR_API_URL in your .env');
  }
  return normalizeBaseUrl(resolvedApiUrl.trim());
}

function toRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

export class StendarApiClient {
  private readonly apiUrl: string;
  private readonly apiKey?: string;
  private readonly sessionBearerToken?: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly additionalHeaders: Record<string, string>;

  constructor(config: HttpClientConfig = {}) {
    this.apiUrl = resolveApiUrl(config.apiUrl);
    this.apiKey = config.apiKey || process.env.STENDAR_API_KEY;
    this.sessionBearerToken = config.sessionBearerToken || process.env.STENDAR_SESSION_BEARER_TOKEN;
    this.timeoutMs = config.timeoutMs ?? 30_000;
    this.fetchFn = config.fetch || globalThis.fetch;
    this.additionalHeaders = config.headers || {};

    if (typeof this.fetchFn !== 'function') {
      throw new Error('A fetch implementation is required in this runtime');
    }
  }

  private buildUrl(path: string): string {
    if (/^https?:\/\//i.test(path)) {
      return path;
    }
    return `${this.apiUrl}${path.startsWith('/') ? path : `/${path}`}`;
  }

  private buildHeaders(includeJsonContentType: boolean): Record<string, string> {
    const headers: Record<string, string> = {
      ...this.additionalHeaders,
    };
    if (includeJsonContentType) {
      headers['Content-Type'] = 'application/json';
    }
    if (this.apiKey) {
      headers['X-API-Key'] = this.apiKey;
    }
    if (this.sessionBearerToken) {
      headers.Authorization = `Bearer ${this.sessionBearerToken}`;
    }
    return headers;
  }

  private async parseResponseBody(response: Response): Promise<unknown> {
    const rawText = await response.text();
    if (!rawText) {
      return null;
    }
    try {
      return JSON.parse(rawText);
    } catch {
      return rawText;
    }
  }

  private unwrapEnvelope<T>(response: Response, payload: unknown): T {
    const body = toRecord(payload);
    const isEnvelope = body && typeof body.success === 'boolean' &&
      (Object.prototype.hasOwnProperty.call(body, 'data') || Object.prototype.hasOwnProperty.call(body, 'error'));

    if (isEnvelope) {
      if (body.success === true) {
        return (body.data as T) ?? (undefined as unknown as T);
      }

      const errorPayload = toRecord(body.error);
      throw new StendarApiError({
        code: typeof errorPayload?.code === 'string' ? errorPayload.code : `HTTP_${response.status}`,
        message:
          typeof errorPayload?.message === 'string'
            ? errorPayload.message
            : `Request failed with status ${response.status}`,
        details: toRecord(errorPayload?.details) || undefined,
        status: response.status,
        requestId: typeof body.meta === 'object' && body.meta && !Array.isArray(body.meta)
          ? String((body.meta as Record<string, unknown>).requestId || '')
          : undefined,
      });
    }

    if (!response.ok) {
      const errorBody = toRecord(payload);
      throw new StendarApiError({
        code: typeof errorBody?.code === 'string' ? errorBody.code : `HTTP_${response.status}`,
        message:
          typeof errorBody?.error === 'string'
            ? errorBody.error
            : typeof errorBody?.message === 'string'
              ? errorBody.message
              : `Request failed with status ${response.status}`,
        details: errorBody || undefined,
        status: response.status,
        requestId: String(response.headers.get('x-request-id') || ''),
      });
    }

    return payload as T;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchFn(this.buildUrl(path), {
        method,
        headers: this.buildHeaders(body !== undefined),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const parsedBody = await this.parseResponseBody(response);
      return this.unwrapEnvelope<T>(response, parsedBody);
    } catch (error) {
      if (error instanceof StendarApiError) {
        throw error;
      }
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Request timed out after ${this.timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }

  put<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PUT', path, body);
  }

  delete<T>(path: string): Promise<T> {
    return this.request<T>('DELETE', path);
  }
}

export class StendarClient {
  readonly mode: StendarClientMode;
  readonly api: StendarApiClient;
  readonly program?: StendarProgramClient;
  readonly jobs: JobActions;
  readonly lending: LendingActions;
  readonly trading: TradingActions;
  readonly proposals: ProposalActions;
  readonly community: CommunityActions;
  readonly contracts: ContractsQueries;
  readonly proposalQueries: ProposalQueries;
  readonly tradingQueries: TradingQueries;
  readonly collateral: CollateralQueries;
  readonly wallet: WalletQueries;
  readonly communityQueries: CommunityQueries;
  readonly market: MarketQueries;
  readonly platform: PlatformQueries;

  constructor(config: StendarClientConfig = {}) {
    this.mode = config.mode || (config.direct ? 'direct' : 'api');
    this.api = new StendarApiClient(config);
    this.program = config.direct ? new StendarProgramClient(config.direct) : undefined;

    this.jobs = new JobActions(this.api);
    this.lending = new LendingActions(this.api, this.mode, this.program);
    this.trading = new TradingActions(this.api);
    this.proposals = new ProposalActions(this.api, this.mode, this.program);
    this.community = new CommunityActions(this.api);
    this.contracts = new ContractsQueries(this.api);
    this.proposalQueries = new ProposalQueries(this.api);
    this.tradingQueries = new TradingQueries(this.api);
    this.collateral = new CollateralQueries(this.api);
    this.wallet = new WalletQueries(this.api);
    this.communityQueries = new CommunityQueries(this.api);
    this.market = new MarketQueries(this.api);
    this.platform = new PlatformQueries(this.api);
  }
}
