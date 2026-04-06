import assert from 'node:assert/strict';
import test from 'node:test';
import { Keypair, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
import type { StendarApiClient } from '../client';
import { CommunityActions } from '../actions/community';
import { LendingActions } from '../actions/lending';
import { ProposalActions } from '../actions/proposals';
import { CollateralQueries } from '../queries/collateral';
import { CommunityQueries } from '../queries/community';
import { ContractsQueries } from '../queries/contracts';
import { PlatformQueries } from '../queries/platform';
import { ProposalQueries } from '../queries/proposals';
import { RatesQueries } from '../queries/rates';
import { TradingQueries } from '../queries/trading';
import { WalletQueries } from '../queries/wallet';

function createMockApiClient() {
  const calls: Array<{ method: 'get' | 'post'; path: string; body?: unknown }> = [];
  const unsignedTransaction = (() => {
    const transaction = new Transaction();
    transaction.feePayer = Keypair.generate().publicKey;
    transaction.recentBlockhash = '11111111111111111111111111111111';
    transaction.add(
      new TransactionInstruction({
        keys: [],
        programId: new PublicKey(new Uint8Array(32).fill(9)),
        data: Buffer.alloc(1),
      })
    );
    return transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
  })();

  const api = {
    get: async <T>(path: string): Promise<T> => {
      calls.push({ method: 'get', path });
      return { ok: true, path } as T;
    },
    post: async <T>(path: string, body?: unknown): Promise<T> => {
      calls.push({ method: 'post', path, body });
      return {
        ok: true,
        path,
        body,
        unsignedTransaction,
        requiredSigners: [],
        estimatedFee: 0,
        status: 'built',
        instructions: [],
      } as T;
    },
  } as unknown as StendarApiClient;

  return { api, calls };
}

function makeAddress(seed: number): string {
  const bytes = Buffer.alloc(32);
  bytes.writeUInt32LE(seed, 0);
  return new PublicKey(bytes).toBase58();
}

test('proposal queries map to proposal endpoints', async () => {
  const { api, calls } = createMockApiClient();
  const queries = new ProposalQueries(api);
  const contractAddress = makeAddress(1);
  const walletAddress = makeAddress(2);

  await queries.list(contractAddress);
  await queries.getActive(contractAddress);
  await queries.get(contractAddress, '7');
  await queries.getCooldown(contractAddress, walletAddress);

  assert.deepEqual(
    calls.map((call) => call.path),
    [
      `/api/contracts/${contractAddress}/proposals`,
      `/api/contracts/${contractAddress}/proposals/active`,
      `/api/contracts/${contractAddress}/proposals/7`,
      `/api/contracts/${contractAddress}/proposals/cooldown/${walletAddress}`,
    ]
  );
});

test('trading queries map list and event endpoints', async () => {
  const { api, calls } = createMockApiClient();
  const queries = new TradingQueries(api);
  const contractAddress = makeAddress(10);
  const sellerAddress = makeAddress(11);
  const listingAddress = makeAddress(12);
  const buyerAddress = makeAddress(13);
  const offerAddress = makeAddress(14);
  const lenderAddress = makeAddress(15);

  await queries.listListings();
  await queries.listListings({ contractAddress });
  await queries.listListings({ sellerAddress });
  await queries.getListing(listingAddress);
  await queries.getOffersByListing(listingAddress);
  await queries.getOffersByBuyer(buyerAddress);
  await queries.getOffer(offerAddress);
  await queries.getPositionValue(contractAddress, lenderAddress);
  await queries.getEvents({ contractAddress, lenderAddress });

  assert.deepEqual(
    calls.map((call) => call.path),
    [
      '/api/trading/listings',
      `/api/trading/listings/contract/${contractAddress}`,
      `/api/trading/listings/seller/${sellerAddress}`,
      `/api/trading/listings/${listingAddress}`,
      `/api/trading/listings/${listingAddress}/offers`,
      `/api/trading/offers/buyer/${buyerAddress}`,
      `/api/trading/offers/${offerAddress}`,
      `/api/trading/position/${contractAddress}/${lenderAddress}/value`,
      `/api/trading/events?contractAddress=${contractAddress}&lenderAddress=${lenderAddress}`,
    ]
  );
});

test('contracts queries include added borrower, health, payments endpoints', async () => {
  const { api, calls } = createMockApiClient();
  const queries = new ContractsQueries(api);
  const contractAddress = makeAddress(20);
  const borrowerAddress = makeAddress(21);

  await queries.getHealth(contractAddress);
  await queries.getContributions(contractAddress);
  await queries.getByBorrower(borrowerAddress);
  await queries.getPaymentsDue();

  assert.deepEqual(
    calls.map((call) => call.path),
    [
      `/api/contracts/${contractAddress}/health`,
      `/api/contracts/${contractAddress}/contributions`,
      `/api/profile/${borrowerAddress}/contracts`,
      '/api/contracts/payments-due',
    ]
  );
});

test('platform queries include state, stats, and notifications endpoints', async () => {
  const { api, calls } = createMockApiClient();
  const queries = new PlatformQueries(api);
  const walletAddress = makeAddress(30);

  await queries.getState();
  await queries.getStats();
  await queries.getNotifications(walletAddress);

  assert.deepEqual(
    calls.map((call) => call.path),
    [
      '/api/platform/state',
      '/api/platform/stats',
      `/api/system/notifications/${walletAddress}`,
    ]
  );
});

test('rates queries map benchmark and guidance endpoints', async () => {
  const { api, calls } = createMockApiClient();
  const queries = new RatesQueries(api);

  await queries.getBenchmark();
  await queries.getBenchmark({
    collateralMint: 'mint-1',
    loanType: 'demand',
    termBucket: 'short',
    sizeBucket: 'small',
  });
  await queries.getBorrowerGuidance({
    interestRate: 8.5,
    collateralMint: 'mint-1',
    loanType: 'committed',
    termDays: 30,
    amount: 1500,
  });
  await queries.getSellerGuidance({
    contractAddress: 'contract-1',
    lenderAddress: 'lender-1',
    askingPrice: 99.25,
  });
  await queries.getDashboard();

  assert.deepEqual(
    calls.map((call) => call.path),
    [
      '/api/rates/benchmark',
      '/api/rates/benchmark?collateralMint=mint-1&loanType=demand&termBucket=short&sizeBucket=small',
      '/api/rates/guidance/borrower?interestRate=8.5&collateralMint=mint-1&loanType=committed&termDays=30&amount=1500',
      '/api/rates/guidance/seller?contractAddress=contract-1&lenderAddress=lender-1&askingPrice=99.25',
      '/api/rates/dashboard',
    ]
  );
});

test('collateral, wallet, and community queries map endpoints', async () => {
  const { api, calls } = createMockApiClient();
  const collateral = new CollateralQueries(api);
  const wallet = new WalletQueries(api);
  const community = new CommunityQueries(api);
  const walletAddress = makeAddress(40);

  await collateral.getRegistry();
  await collateral.getPrice('mint-1');
  await wallet.getBalance(walletAddress);
  await community.getFeatureLeaderboard(25);

  assert.deepEqual(
    calls.map((call) => call.path),
    [
      '/api/collateral/registry',
      '/api/collateral/price/mint-1',
      `/api/wallet/${walletAddress}/balance`,
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

test('lending withdrawContribution posts to withdraw endpoint', async () => {
  const { api, calls } = createMockApiClient();
  const actions = new LendingActions(api, 'api');
  const contractAddress = makeAddress(50);

  await actions.withdrawContribution({
    contractAddress,
    lenderAddress: 'lender-1',
    contributionAddress: 'contribution-1',
    escrowAddress: 'escrow-1',
    contractUsdcAccount: 'contract-usdc-1',
    lenderUsdcAccount: 'lender-usdc-1',
  });

  assert.deepEqual(calls, [
    {
      method: 'post',
      path: `/api/contracts/${contractAddress}/withdraw-contribution`,
      body: {
        contractAddress,
        lenderAddress: 'lender-1',
        contributionAddress: 'contribution-1',
        escrowAddress: 'escrow-1',
        contractUsdcAccount: 'contract-usdc-1',
        lenderUsdcAccount: 'lender-usdc-1',
      },
    },
  ]);
});

test('proposal actions route processProposalRecall endpoint', async () => {
  const { api, calls } = createMockApiClient();
  const actions = new ProposalActions(api, 'api');
  const contractAddress = makeAddress(60);

  await actions.processProposalRecall({
    contractAddress,
    proposalId: '1',
    voterAddress: 'voter-1',
    botAuthorityAddress: 'bot-1',
    contributionAddress: 'contrib-1',
    escrowAddress: 'escrow-1',
    borrowerAddress: 'borrower-1',
    botUsdcAta: 'bot-usdc-1',
    escrowUsdcAta: 'escrow-usdc-1',
    treasuryUsdcAta: 'treasury-usdc-1',
    contractCollateralAta: 'contract-col-1',
    botCollateralAta: 'bot-col-1',
  });

  assert.deepEqual(calls, [
    {
      method: 'post',
      path: `/api/proposals/${contractAddress}/process-recall`,
      body: {
        contractAddress,
        proposalId: '1',
        voterAddress: 'voter-1',
        botAuthorityAddress: 'bot-1',
        contributionAddress: 'contrib-1',
        escrowAddress: 'escrow-1',
        borrowerAddress: 'borrower-1',
        botUsdcAta: 'bot-usdc-1',
        escrowUsdcAta: 'escrow-usdc-1',
        treasuryUsdcAta: 'treasury-usdc-1',
        contractCollateralAta: 'contract-col-1',
        botCollateralAta: 'bot-col-1',
      },
    },
  ]);
});
