import assert from 'node:assert/strict';
import test from 'node:test';
import type { StendarApiClient } from '../client';
import { CommunityActions } from '../actions/community';
import { CollateralQueries } from '../queries/collateral';
import { CommunityQueries } from '../queries/community';
import { ContractsQueries } from '../queries/contracts';
import { PlatformQueries } from '../queries/platform';
import { ProposalQueries } from '../queries/proposals';
import { TradingQueries } from '../queries/trading';
import { WalletQueries } from '../queries/wallet';

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

test('proposal queries map to proposal endpoints', async () => {
  const { api, calls } = createMockApiClient();
  const queries = new ProposalQueries(api);

  await queries.list('contract-1');
  await queries.getActive('contract-1');
  await queries.get('contract-1', '7');
  await queries.getCooldown('contract-1', 'wallet-1');

  assert.deepEqual(
    calls.map((call) => call.path),
    [
      '/api/contracts/contract-1/proposals',
      '/api/contracts/contract-1/proposals/active',
      '/api/contracts/contract-1/proposals/7',
      '/api/contracts/contract-1/proposals/cooldown/wallet-1',
    ]
  );
});

test('trading queries map list and event endpoints', async () => {
  const { api, calls } = createMockApiClient();
  const queries = new TradingQueries(api);

  await queries.listListings();
  await queries.listListings({ contractAddress: 'contract-1' });
  await queries.listListings({ sellerAddress: 'seller-1' });
  await queries.getListing('listing-1');
  await queries.getOffersByListing('listing-1');
  await queries.getOffersByBuyer('buyer-1');
  await queries.getOffer('offer-1');
  await queries.getPositionValue('contract-1', 'lender-1');
  await queries.getEvents({ contractAddress: 'contract-1', lenderAddress: 'lender-1' });

  assert.deepEqual(
    calls.map((call) => call.path),
    [
      '/api/trading/listings',
      '/api/trading/listings/contract/contract-1',
      '/api/trading/listings/seller/seller-1',
      '/api/trading/listings/listing-1',
      '/api/trading/listings/listing-1/offers',
      '/api/trading/offers/buyer/buyer-1',
      '/api/trading/offers/offer-1',
      '/api/trading/position/contract-1/lender-1/value',
      '/api/trading/events?contractAddress=contract-1&lenderAddress=lender-1',
    ]
  );
});

test('contracts queries include added borrower, health, payments endpoints', async () => {
  const { api, calls } = createMockApiClient();
  const queries = new ContractsQueries(api);

  await queries.getHealth('contract-1');
  await queries.getContributions('contract-1');
  await queries.getByBorrower('borrower-1');
  await queries.getPaymentsDue();

  assert.deepEqual(
    calls.map((call) => call.path),
    [
      '/api/contracts/contract-1/health',
      '/api/contracts/contract-1/contributions',
      '/api/profile/borrower-1/contracts',
      '/api/contracts/payments-due',
    ]
  );
});

test('platform queries include state, stats, and notifications endpoints', async () => {
  const { api, calls } = createMockApiClient();
  const queries = new PlatformQueries(api);

  await queries.getState();
  await queries.getStats();
  await queries.getNotifications('wallet-1');

  assert.deepEqual(
    calls.map((call) => call.path),
    [
      '/api/platform/state',
      '/api/platform/stats',
      '/api/system/notifications/wallet-1',
    ]
  );
});

test('collateral, wallet, and community queries map endpoints', async () => {
  const { api, calls } = createMockApiClient();
  const collateral = new CollateralQueries(api);
  const wallet = new WalletQueries(api);
  const community = new CommunityQueries(api);

  await collateral.getRegistry();
  await collateral.getPrice('mint-1');
  await wallet.getBalance('wallet-1');
  await community.getFeatureLeaderboard(25);

  assert.deepEqual(
    calls.map((call) => call.path),
    [
      '/api/collateral/registry',
      '/api/collateral/price/mint-1',
      '/api/wallet/wallet-1/balance',
      '/api/community/feature-requests/leaderboard?limit=25',
    ]
  );
});

test('community actions post to support, bug report, and feature request endpoints', async () => {
  const { api, calls } = createMockApiClient();
  const actions = new CommunityActions(api);

  await actions.submitSupport({
    name: 'Agent',
    email: 'agent@example.com',
    message: 'Need help reproducing issue',
  });
  await actions.submitBugReport({
    title: 'UI edge case',
    description: 'Repro steps go here.',
    severity: 'high',
  });
  await actions.submitFeatureRequest({
    title: 'Add programmatic webhook',
    description: 'Need webhooks for settlement updates.',
    category: 'automation',
    contactEmail: 'agent@example.com',
  });

  assert.deepEqual(
    calls.map((call) => ({ method: call.method, path: call.path })),
    [
      { method: 'post', path: '/api/community/support' },
      { method: 'post', path: '/api/community/bug-reports' },
      { method: 'post', path: '/api/community/feature-requests' },
    ]
  );
});
