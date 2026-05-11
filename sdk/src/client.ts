import { CommunityActions } from './actions/community';
import { JobActions } from './actions/jobs';
import { LendingActions } from './actions/lending';
import { ProposalActions } from './actions/proposals';
import { TradingActions } from './actions/trading';
import { StendarApiClient } from './http-client';
import { StendarProgramClient } from './program';
import { CollateralQueries } from './queries/collateral';
import { CommunityQueries } from './queries/community';
import { ContractsQueries } from './queries/contracts';
import { MarketQueries } from './queries/market';
import { PlatformQueries } from './queries/platform';
import { ProposalQueries } from './queries/proposals';
import { RatesQueries } from './queries/rates';
import { TradingQueries } from './queries/trading';
import { WalletQueries } from './queries/wallet';
import { StendarClientConfig, StendarClientMode } from './types';

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
  readonly rates: RatesQueries;
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
    this.rates = new RatesQueries(this.api);
    this.platform = new PlatformQueries(this.api);
  }
}
