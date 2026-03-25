import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { Keypair, Transaction } from '@solana/web3.js';
import * as anchor from '@coral-xyz/anchor';
import { BlockchainContractService } from '../app/backend/services/blockchainContractService';
import { loadCollateralListingManifest } from '../app/backend/services/collateralListingManifest';
import {
  buildCollateralRegistryPlan,
  type CollateralRegistryMutationAction,
  type RegistryCollateralType,
} from '../app/backend/services/collateralListingPlanner';

interface CliOptions {
  manifestPath: string;
  execute: boolean;
  deactivateMissing: boolean;
  authorityKeypairPath?: string;
  authorityPrivateKey?: string;
}

interface ExecutionResult {
  type: string;
  mint?: string;
  symbol?: string;
  status: 'planned' | 'submitted' | 'failed';
  transactionSignature?: string;
  error?: string;
}

const DEFAULT_MANIFEST_PATH = 'security/collateral-listings/devnet.json';

function usage(): string {
  return [
    'Usage: npx ts-node scripts/apply-collateral-manifest.ts [options]',
    '',
    'Options:',
    `  --manifest <path>                Manifest path (default: ${DEFAULT_MANIFEST_PATH})`,
    '  --execute                        Execute on-chain mutations (default: dry-run)',
    '  --keep-missing-active            Do not deactivate active registry mints missing from manifest',
    '  --authority-keypair-path <path>  JSON keypair path for execute mode',
    '  --authority-private-key <key>    Base58 or JSON-array secret key for execute mode',
    '  --help                           Show this help text',
  ].join('\n');
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    manifestPath: DEFAULT_MANIFEST_PATH,
    execute: false,
    deactivateMissing: true,
    authorityKeypairPath: process.env.AUTHORITY_KEYPAIR_PATH || process.env.SOLANA_WALLET_PATH,
    authorityPrivateKey: process.env.COLLATERAL_ADMIN_PRIVATE_KEY || process.env.BOT_AUTHORITY_PRIVATE_KEY,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help') {
      console.log(usage());
      process.exit(0);
    }
    if (arg === '--manifest') {
      options.manifestPath = argv[++i] || '';
      continue;
    }
    if (arg === '--execute') {
      options.execute = true;
      continue;
    }
    if (arg === '--keep-missing-active') {
      options.deactivateMissing = false;
      continue;
    }
    if (arg === '--authority-keypair-path') {
      options.authorityKeypairPath = argv[++i] || '';
      continue;
    }
    if (arg === '--authority-private-key') {
      options.authorityPrivateKey = argv[++i] || '';
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function expandHome(inputPath: string): string {
  if (!inputPath.startsWith('~')) {
    return inputPath;
  }
  const home = process.env.HOME;
  if (!home) {
    throw new Error('Cannot expand "~" in keypair path because HOME is not set');
  }
  return path.join(home, inputPath.slice(1));
}

function parseSecretKey(privateKeyValue: string): Uint8Array {
  const trimmed = privateKeyValue.trim();
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const parsed = JSON.parse(trimmed) as number[];
    return Uint8Array.from(parsed);
  }
  return Uint8Array.from(anchor.utils.bytes.bs58.decode(trimmed));
}

function resolveAuthorityKeypair(options: CliOptions): Keypair {
  if (options.authorityPrivateKey && options.authorityPrivateKey.trim().length > 0) {
    return Keypair.fromSecretKey(parseSecretKey(options.authorityPrivateKey));
  }

  const fallbackPath =
    options.authorityKeypairPath && options.authorityKeypairPath.trim().length > 0
      ? expandHome(options.authorityKeypairPath)
      : path.join(process.env.HOME || '', '.config/solana/id.json');

  if (!fallbackPath || !fs.existsSync(fallbackPath)) {
    throw new Error(
      `Authority keypair is required for execute mode. Missing keypair path: ${fallbackPath || '(unset)'}`
    );
  }

  const raw = fs.readFileSync(fallbackPath, 'utf8');
  const secretKeyBytes = Uint8Array.from(JSON.parse(raw) as number[]);
  return Keypair.fromSecretKey(secretKeyBytes);
}

function extractRegistryEntries(registryPayload: unknown): RegistryCollateralType[] | null {
  if (!registryPayload || typeof registryPayload !== 'object') {
    return null;
  }
  const typed = registryPayload as {
    account?: {
      collateral_types?: Array<{
        mint: string;
        oracle_price_feed: string;
        decimals: number;
        liquidation_buffer_bps: number;
        min_committed_floor_bps: number;
        is_active: boolean;
      }>;
    };
  };
  const entries = typed.account?.collateral_types;
  if (!Array.isArray(entries)) {
    return null;
  }
  return entries.map((entry) => ({
    mint: entry.mint,
    oracle_price_feed: entry.oracle_price_feed,
    decimals: entry.decimals,
    liquidation_buffer_bps: entry.liquidation_buffer_bps,
    min_committed_floor_bps: entry.min_committed_floor_bps,
    is_active: entry.is_active,
  }));
}

function actionIdentity(action: CollateralRegistryMutationAction): Pick<ExecutionResult, 'type' | 'mint' | 'symbol'> {
  if (action.type === 'initialize') {
    return { type: action.type };
  }
  if (action.type === 'add') {
    return { type: action.type, mint: action.asset.mint, symbol: action.asset.symbol };
  }
  if (action.type === 'update') {
    return { type: action.type, mint: action.mint, symbol: action.symbol };
  }
  return { type: action.type, mint: action.mint };
}

function makeSubmissionId(manifestPath: string, action: CollateralRegistryMutationAction, authority: string): string {
  return createHash('sha256')
    .update(JSON.stringify({ manifestPath, action: actionIdentity(action), authority }))
    .digest('hex');
}

async function createMutationTransaction(
  service: BlockchainContractService,
  authorityAddress: string,
  action: CollateralRegistryMutationAction
): Promise<{ unsignedTransaction: string; contractAddress: string }> {
  if (action.type === 'initialize') {
    const response = await service.createInitializeCollateralRegistryTransaction(authorityAddress);
    if (!response.success || !response.unsignedTransaction) {
      throw new Error(response.error || 'Failed to build initialize transaction');
    }
    return {
      unsignedTransaction: response.unsignedTransaction,
      contractAddress: response.contractAddress,
    };
  }

  if (action.type === 'add') {
    const response = await service.createAddCollateralTypeTransaction({
      authorityAddress,
      collateralMint: action.asset.mint,
      oraclePriceFeed: action.asset.oraclePriceFeed,
      decimals: action.asset.decimals,
      liquidationBufferBps: action.asset.liquidationBufferBps,
      minCommittedFloorBps: action.asset.minCommittedFloorBps,
    });
    if (!response.success || !response.unsignedTransaction) {
      throw new Error(response.error || `Failed to build add transaction for ${action.asset.mint}`);
    }
    return {
      unsignedTransaction: response.unsignedTransaction,
      contractAddress: response.contractAddress,
    };
  }

  if (action.type === 'update') {
    const response = await service.createUpdateCollateralTypeTransaction({
      authorityAddress,
      mint: action.mint,
      newOraclePriceFeed: action.patch.newOraclePriceFeed,
      newLiquidationBufferBps: action.patch.newLiquidationBufferBps,
      newMinCommittedFloorBps: action.patch.newMinCommittedFloorBps,
    });
    if (!response.success || !response.unsignedTransaction) {
      throw new Error(response.error || `Failed to build update transaction for ${action.mint}`);
    }
    return {
      unsignedTransaction: response.unsignedTransaction,
      contractAddress: response.contractAddress,
    };
  }

  const response = await service.createDeactivateCollateralTypeTransaction({
    authorityAddress,
    mint: action.mint,
  });
  if (!response.success || !response.unsignedTransaction) {
    throw new Error(response.error || `Failed to build deactivate transaction for ${action.mint}`);
  }
  return {
    unsignedTransaction: response.unsignedTransaction,
    contractAddress: response.contractAddress,
  };
}

async function run(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  const manifest = loadCollateralListingManifest(options.manifestPath);
  const service = new BlockchainContractService();
  await service.initialize();

  const currentRegistry = await service.getCollateralRegistry();
  const currentEntries = extractRegistryEntries(currentRegistry);
  const plan = buildCollateralRegistryPlan(manifest.assets, currentEntries, {
    deactivateMissing: options.deactivateMissing,
  });

  const output: {
    success: boolean;
    mode: 'dry-run' | 'execute';
    manifestPath: string;
    environment: string;
    authorityWallet: string | null;
    actions: ExecutionResult[];
    unchangedMints: string[];
    warnings: string[];
    unsupported: string[];
    postApplyRemainingActions?: number;
  } = {
    success: false,
    mode: options.execute ? 'execute' : 'dry-run',
    manifestPath: options.manifestPath,
    environment: manifest.environment,
    authorityWallet: null,
    actions: plan.actions.map((action) => ({
      ...actionIdentity(action),
      status: 'planned',
    })),
    unchangedMints: plan.unchangedMints,
    warnings: plan.warnings,
    unsupported: plan.unsupported,
  };

  if (!options.execute) {
    output.success = plan.unsupported.length === 0;
    console.log(JSON.stringify(output, null, 2));
    return output.success ? 0 : 1;
  }

  if (plan.unsupported.length > 0) {
    output.success = false;
    console.log(JSON.stringify(output, null, 2));
    return 1;
  }

  const authority = resolveAuthorityKeypair(options);
  const authorityAddress = authority.publicKey.toBase58();
  output.authorityWallet = authorityAddress;

  const executionResults: ExecutionResult[] = [];
  for (const action of plan.actions) {
    const baseResult: ExecutionResult = {
      ...actionIdentity(action),
      status: 'planned',
    };

    try {
      const built = await createMutationTransaction(service, authorityAddress, action);
      const transaction = Transaction.from(Buffer.from(built.unsignedTransaction, 'base64'));
      transaction.partialSign(authority);
      const signedTransactionBase64 = transaction.serialize().toString('base64');
      const submissionId = makeSubmissionId(options.manifestPath, action, authorityAddress);

      const submission = await service.submitSignedTransaction({
        signedTransactionBase64,
        expectedWalletAddress: authorityAddress,
        contractAddress: built.contractAddress,
        submissionId,
      });
      if (!submission.success || !submission.transactionSignature) {
        throw new Error(submission.error || 'Transaction submission failed');
      }

      executionResults.push({
        ...baseResult,
        status: 'submitted',
        transactionSignature: submission.transactionSignature,
      });
    } catch (error) {
      executionResults.push({
        ...baseResult,
        status: 'failed',
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      output.actions = executionResults;
      output.success = false;
      console.log(JSON.stringify(output, null, 2));
      return 1;
    }
  }

  output.actions = executionResults;

  const latestRegistry = await service.getCollateralRegistry();
  const latestEntries = extractRegistryEntries(latestRegistry);
  const postPlan = buildCollateralRegistryPlan(manifest.assets, latestEntries, {
    deactivateMissing: options.deactivateMissing,
  });
  output.postApplyRemainingActions = postPlan.actions.length + postPlan.unsupported.length;
  output.success = output.postApplyRemainingActions === 0;
  if (postPlan.warnings.length > 0) {
    output.warnings = [...output.warnings, ...postPlan.warnings];
  }

  console.log(JSON.stringify(output, null, 2));
  return output.success ? 0 : 1;
}

void run()
  .then((exitCode) => {
    process.exit(exitCode);
  })
  .catch((error) => {
    console.log(
      JSON.stringify(
        {
          success: false,
          mode: 'dry-run',
          error: error instanceof Error ? error.message : String(error),
        },
        null,
        2
      )
    );
    process.exit(1);
  });
