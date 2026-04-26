import { stendarIdl } from '../idl';

type IdlAccountWithDiscriminator = {
  name: string;
  discriminator: number[];
};

function getIdlAccounts(): IdlAccountWithDiscriminator[] {
  const accounts = (stendarIdl as unknown as { accounts?: IdlAccountWithDiscriminator[] }).accounts;
  return Array.isArray(accounts) ? accounts : [];
}

function extractDiscriminator(accountName: string): Buffer {
  const account = getIdlAccounts().find((entry) => entry.name === accountName);
  if (!account) {
    throw new Error(`Account "${accountName}" was not found in the Stendar IDL`);
  }
  if (!Array.isArray(account.discriminator) || account.discriminator.length !== 8) {
    throw new Error(`Account "${accountName}" has an invalid discriminator in the Stendar IDL`);
  }
  return Buffer.from(account.discriminator);
}

let cachedDiscriminators: Record<string, Buffer> | null = null;

function buildDiscriminators(): Record<string, Buffer> {
  return {
    // Core lending + governance accounts
    STATE: extractDiscriminator('State'),
    DEBT_CONTRACT: extractDiscriminator('DebtContract'),
    LENDER_CONTRIBUTION: extractDiscriminator('LenderContribution'),
    LENDER_ESCROW: extractDiscriminator('LenderEscrow'),
    COLLATERAL_REGISTRY: extractDiscriminator('CollateralRegistry'),
    TERM_AMENDMENT_PROPOSAL: extractDiscriminator('TermAmendmentProposal'),
    PROPOSAL_VOTE: extractDiscriminator('ProposalVote'),
    PROPOSER_COOLDOWN: extractDiscriminator('ProposerCooldown'),

    // Secondary market accounts
    TRADE_LISTING: extractDiscriminator('TradeListing'),
    TRADE_OFFER: extractDiscriminator('TradeOffer'),
    TRADE_EVENT: extractDiscriminator('TradeEvent'),

    // Pool accounts
    POOL_STATE: extractDiscriminator('PoolState'),
    POOL_DEPOSIT: extractDiscriminator('PoolDeposit'),

    // Other protocol accounts
    APPROVED_FUNDER: extractDiscriminator('ApprovedFunder'),
    TREASURY: extractDiscriminator('Treasury'),
    CONTRACT_OPERATIONS_FUND: extractDiscriminator('ContractOperationsFund'),
  };
}

function getDiscriminators(): Record<string, Buffer> {
  if (!cachedDiscriminators) {
    cachedDiscriminators = buildDiscriminators();
  }
  return cachedDiscriminators;
}

export const DISCRIMINATORS: Record<string, Buffer> = new Proxy({} as Record<string, Buffer>, {
  get(_target, property: string | symbol): Buffer {
    return getDiscriminators()[String(property)];
  },
  has(_target, property: string | symbol): boolean {
    return Object.prototype.hasOwnProperty.call(getDiscriminators(), String(property));
  },
  ownKeys(): ArrayLike<string | symbol> {
    return Reflect.ownKeys(getDiscriminators());
  },
  getOwnPropertyDescriptor(_target, property: string | symbol): PropertyDescriptor | undefined {
    const key = String(property);
    if (!Object.prototype.hasOwnProperty.call(getDiscriminators(), key)) {
      return undefined;
    }
    return {
      enumerable: true,
      configurable: true,
      value: getDiscriminators()[key],
      writable: false,
    };
  },
});
