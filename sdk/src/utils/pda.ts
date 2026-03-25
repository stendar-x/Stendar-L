import { PublicKey } from '@solana/web3.js';

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

function resolveProgramIdFromEnv(): string | undefined {
  for (const key of PROGRAM_ID_ENV_KEYS) {
    const value = process.env[key];
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

export function deriveContractPda(
  borrowerAddress: string,
  contractSeed: string | number | bigint,
  programId?: string
): PublicKey {
  const resolvedProgramId = resolveProgramId(programId);
  const borrower = new PublicKey(borrowerAddress);
  const [contractPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('contract'), borrower.toBuffer(), toU64LeBuffer(contractSeed)],
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
