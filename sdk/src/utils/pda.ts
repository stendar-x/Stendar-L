import { Connection, PublicKey } from '@solana/web3.js';
import { safeReadEnv } from './env';

const PROGRAM_ID_ENV_KEYS = ['STENDAR_PROGRAM_ID', 'SOLANA_PROGRAM_ID'] as const;

function toU64LeBuffer(value: string | number | bigint): Buffer {
  const asBigInt = BigInt(value);
  if (asBigInt < 0n) {
    throw new Error('u64 value must be non-negative');
  }
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(asBigInt);
  return buffer;
}

function toNonceBuffer(value: number): Buffer {
  if (!Number.isInteger(value) || value < 0 || value > 255) {
    throw new Error('nonce must be an integer between 0 and 255');
  }
  return Buffer.from([value]);
}

function toPublicKey(value: string | PublicKey): PublicKey {
  return value instanceof PublicKey ? value : new PublicKey(value);
}

function resolveProgramIdFromEnv(): string | undefined {
  for (const key of PROGRAM_ID_ENV_KEYS) {
    const value = safeReadEnv(key);
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

export function resolveProgramId(programId?: string): PublicKey {
  const resolvedProgramId = programId || resolveProgramIdFromEnv();
  if (!resolvedProgramId) {
    throw new Error(
      `programId is required. Provide programId explicitly or set ${PROGRAM_ID_ENV_KEYS.join(' or ')} in .env`
    );
  }
  return new PublicKey(resolvedProgramId);
}

export function deriveGlobalStatePda(programId?: string): PublicKey {
  const resolvedProgramId = resolveProgramId(programId);
  const [statePda] = PublicKey.findProgramAddressSync([Buffer.from('global_state')], resolvedProgramId);
  return statePda;
}

export function deriveTreasuryPda(programId?: string): PublicKey {
  const resolvedProgramId = resolveProgramId(programId);
  const [treasuryPda] = PublicKey.findProgramAddressSync([Buffer.from('treasury')], resolvedProgramId);
  return treasuryPda;
}

export function derivePoolOperatorPda(
  operatorAddress: string | PublicKey,
  programId?: string
): [PublicKey, number] {
  const resolvedProgramId = resolveProgramId(programId);
  const operator = toPublicKey(operatorAddress);
  return PublicKey.findProgramAddressSync(
    [Buffer.from('pool_operator'), operator.toBuffer()],
    resolvedProgramId
  );
}

export function derivePendingPoolChangePda(
  poolAddress: string | PublicKey,
  programId?: string
): [PublicKey, number] {
  const resolvedProgramId = resolveProgramId(programId);
  const pool = toPublicKey(poolAddress);
  return PublicKey.findProgramAddressSync(
    [Buffer.from('pending_pool_change'), pool.toBuffer()],
    resolvedProgramId
  );
}

export function deriveContractPda(
  borrowerAddress: string,
  contractSeed: string | number | bigint,
  programId?: string
): PublicKey {
  const resolvedProgramId = resolveProgramId(programId);
  const borrower = new PublicKey(borrowerAddress);
  const [contractPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('debt_contract'), borrower.toBuffer(), toU64LeBuffer(contractSeed)],
    resolvedProgramId
  );
  return contractPda;
}

export function deriveContributionPda(contractAddress: string, lenderAddress: string, programId?: string): PublicKey {
  const resolvedProgramId = resolveProgramId(programId);
  const contract = new PublicKey(contractAddress);
  const lender = new PublicKey(lenderAddress);
  const [contributionPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('contribution'), contract.toBuffer(), lender.toBuffer()],
    resolvedProgramId
  );
  return contributionPda;
}

export function deriveEscrowPda(contractAddress: string, lenderAddress: string, programId?: string): PublicKey {
  const resolvedProgramId = resolveProgramId(programId);
  const contract = new PublicKey(contractAddress);
  const lender = new PublicKey(lenderAddress);
  const [escrowPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('escrow'), contract.toBuffer(), lender.toBuffer()],
    resolvedProgramId
  );
  return escrowPda;
}

export function deriveApprovedFunderPda(contractAddress: string, lenderAddress: string, programId?: string): PublicKey {
  const resolvedProgramId = resolveProgramId(programId);
  const contract = new PublicKey(contractAddress);
  const lender = new PublicKey(lenderAddress);
  const [approvedFunderPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('approved_funder'), contract.toBuffer(), lender.toBuffer()],
    resolvedProgramId
  );
  return approvedFunderPda;
}

export function deriveTermProposalPda(
  contractAddress: string,
  proposalId: string | number | bigint,
  programId?: string
): PublicKey {
  const resolvedProgramId = resolveProgramId(programId);
  const contract = new PublicKey(contractAddress);
  const [proposalPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('term_proposal'), contract.toBuffer(), toU64LeBuffer(proposalId)],
    resolvedProgramId
  );
  return proposalPda;
}

export function deriveProposalVotePda(proposalAddress: string, voterAddress: string, programId?: string): PublicKey {
  const resolvedProgramId = resolveProgramId(programId);
  const proposal = new PublicKey(proposalAddress);
  const voter = new PublicKey(voterAddress);
  const [votePda] = PublicKey.findProgramAddressSync(
    [Buffer.from('proposal_vote'), proposal.toBuffer(), voter.toBuffer()],
    resolvedProgramId
  );
  return votePda;
}

export function deriveProposerCooldownPda(
  contractAddress: string,
  proposerAddress: string,
  programId?: string
): PublicKey {
  const resolvedProgramId = resolveProgramId(programId);
  const contract = new PublicKey(contractAddress);
  const proposer = new PublicKey(proposerAddress);
  const [cooldownPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('proposer_cooldown'), contract.toBuffer(), proposer.toBuffer()],
    resolvedProgramId
  );
  return cooldownPda;
}

/**
 * Derive listing PDA from contribution and nonce.
 *
 * `_sellerAddress` is accepted only for SDK API parity with external tooling.
 * It is not included in on-chain seed derivation.
 * Nonce is a single byte (`0..=255`). After all nonce slots are used for a contribution,
 * new listing PDAs cannot be derived.
 */
export function deriveListingPda(
  contributionAddress: string | PublicKey,
  _sellerAddress: string | PublicKey,
  nonce: number,
  programId?: string
): [PublicKey, number] {
  void _sellerAddress;
  const resolvedProgramId = resolveProgramId(programId);
  const contribution = toPublicKey(contributionAddress);
  return PublicKey.findProgramAddressSync(
    [Buffer.from('listing'), contribution.toBuffer(), toNonceBuffer(nonce)],
    resolvedProgramId
  );
}

/**
 * Finds the first available listing nonce in the 0..=255 range.
 *
 * This helper reduces, but cannot eliminate, TOCTOU race windows between nonce discovery
 * and transaction submission. Callers should use optimistic retry if a nonce becomes occupied
 * before instruction execution.
 */
export async function findAvailableTradeNonce(
  connection: Connection,
  contributionAddress: string | PublicKey,
  programId?: string
): Promise<number> {
  const placeholderSeller = PublicKey.default;
  const maxNonce = 255;
  const batchSize = 100;

  for (let startNonce = 0; startNonce <= maxNonce; startNonce += batchSize) {
    const endNonceExclusive = Math.min(startNonce + batchSize, maxNonce + 1);
    const batchNonces: number[] = [];
    const batchAccounts: PublicKey[] = [];

    for (let nonce = startNonce; nonce < endNonceExclusive; nonce += 1) {
      batchNonces.push(nonce);
      const [listingPda] = deriveListingPda(contributionAddress, placeholderSeller, nonce, programId);
      batchAccounts.push(listingPda);
    }

    const accountInfos = await connection.getMultipleAccountsInfo(batchAccounts);
    const availableIndex = accountInfos.findIndex((accountInfo) => accountInfo === null);
    if (availableIndex !== -1) {
      return batchNonces[availableIndex];
    }
  }
  throw new Error('No available listing nonce remains in the 0-255 range');
}

export function deriveOfferPda(
  listingAddress: string | PublicKey,
  buyerAddress: string | PublicKey,
  nonce: number,
  programId?: string
): [PublicKey, number] {
  const resolvedProgramId = resolveProgramId(programId);
  const listing = toPublicKey(listingAddress);
  const buyer = toPublicKey(buyerAddress);
  return PublicKey.findProgramAddressSync(
    [Buffer.from('offer'), listing.toBuffer(), buyer.toBuffer(), toNonceBuffer(nonce)],
    resolvedProgramId
  );
}

export function deriveTradeEventPda(
  listingAddress: string | PublicKey,
  nonce: number,
  programId?: string
): [PublicKey, number] {
  const resolvedProgramId = resolveProgramId(programId);
  const listing = toPublicKey(listingAddress);
  return PublicKey.findProgramAddressSync(
    [Buffer.from('trade'), listing.toBuffer(), toNonceBuffer(nonce)],
    resolvedProgramId
  );
}
