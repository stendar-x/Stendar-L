import type { StendarApiClient } from '../client';
import { WebsocketEventsMetadata } from '../types';
import { validateSolanaAddress } from '../utils/validation';

export class PlatformQueries {
  constructor(private readonly api: StendarApiClient) {}

  getState(): Promise<Record<string, unknown>> {
    return this.api.get<Record<string, unknown>>('/api/platform/state');
  }

  getStats(): Promise<Record<string, unknown>> {
    return this.api.get<Record<string, unknown>>('/api/platform/stats');
  }

  getSchedulerStatus(): Promise<Record<string, unknown>> {
    return this.api.get<Record<string, unknown>>('/api/system/scheduler/status');
  }

  getPaymentStats(): Promise<Record<string, unknown>> {
    return this.api.get<Record<string, unknown>>('/api/system/payments/stats');
  }

  getPaymentEvents(limit = 50): Promise<Record<string, unknown>> {
    if (!Number.isFinite(limit) || limit < 1) {
      throw new Error('Invalid limit: expected a positive finite number');
    }
    const clampedLimit = Math.min(Math.floor(limit), 1000);
    return this.api.get<Record<string, unknown>>(`/api/system/payments/events?limit=${clampedLimit}`);
  }

  getWebsocketEventsMetadata(): Promise<WebsocketEventsMetadata> {
    return this.api.get<WebsocketEventsMetadata>('/api/system/websocket/events');
  }

  getNotifications(publicKey: string): Promise<Record<string, unknown>> {
    return this.api.get<Record<string, unknown>>(
      `/api/system/notifications/${validateSolanaAddress(publicKey, 'publicKey')}`
    );
  }
}
