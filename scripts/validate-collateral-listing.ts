import { Connection, PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, unpackMint } from '@solana/spl-token';
import { parseCollateralRegistryAccount } from '../app/backend/services/accountParsers/collateralRegistryParser';
import {
  loadCollateralListingManifest,
  type CollateralListingAsset,
} from '../app/backend/services/collateralListingManifest';
import { parsePriceFeedConfig } from '../app/backend/services/oracleFeedConfig';

type RegistrySource = 'chain' | 'api' | 'both' | 'none';
type Severity = 'error' | 'warning';

interface CliOptions {
  manifestPath: string;
  rpcUrl: string;
  programId?: string;
  apiBaseUrl?: string;
  registrySource: RegistrySource;
  checkFeedHealth: boolean;
  enforceEnvParity: boolean;
  allowMissingRegistry: boolean;
  maxFeedAgeSeconds: number;
  maxConfidenceRatio: number;
}

interface CheckResult {
  scope: 'global' | 'asset';
  severity: Severity;
  check: string;
  ok: boolean;
  message: string;
  symbol?: string;
  mint?: string;
  details?: Record<string, unknown>;
}

interface RegistryEntry {
  mint: string;
  oraclePriceFeed: string;
  decimals: number;
  liquidationBufferBps: number;
  minCommittedFloorBps: number;
  isActive: boolean;
}

interface ParsedFeedData {
  source: 'pyth_receiver' | 'mock_program';
  price: number;
  conf: number;
  exponent: number;
  publishTime: number;
}

const DEFAULT_MANIFEST_PATH = 'security/collateral-listings/devnet.json';
const DEFAULT_RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
const DEFAULT_MAX_FEED_AGE_SECONDS = 120;
const DEFAULT_MAX_CONFIDENCE_RATIO = 0.05;

function usage(): string {
  return [
    'Usage: npx ts-node scripts/validate-collateral-listing.ts [options]',
    '',
    'Options:',
    `  --manifest <path>              Manifest path (default: ${DEFAULT_MANIFEST_PATH})`,
    `  --rpc-url <url>                Solana RPC URL (default: ${DEFAULT_RPC_URL})`,
    '  --program-id <pubkey>          Program ID (defaults to STENDAR_PROGRAM_ID/SOLANA_PROGRAM_ID)',
    '  --api-base-url <url>           Backend API URL for /api/collateral/registry parity checks',
    '  --registry-source <mode>       chain|api|both|none (default: chain)',
    '  --allow-missing-registry       Do not fail when collateral registry account is missing',
    '  --skip-feed-health-check       Skip feed age/confidence checks',
    '  --skip-env-parity              Skip PYTH_PRICE_FEEDS parity checks',
    `  --max-feed-age-seconds <n>     Max oracle age (default: ${DEFAULT_MAX_FEED_AGE_SECONDS})`,
    `  --max-confidence-ratio <n>     Max conf/price ratio (default: ${DEFAULT_MAX_CONFIDENCE_RATIO})`,
    '  --help                         Show this help text',
  ].join('\n');
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    manifestPath: DEFAULT_MANIFEST_PATH,
    rpcUrl: DEFAULT_RPC_URL,
    programId: process.env.STENDAR_PROGRAM_ID?.trim() || process.env.SOLANA_PROGRAM_ID?.trim(),
    apiBaseUrl: process.env.API_BASE_URL?.trim() || undefined,
    registrySource: 'chain',
    checkFeedHealth: true,
    enforceEnvParity: true,
    allowMissingRegistry: false,
    maxFeedAgeSeconds: DEFAULT_MAX_FEED_AGE_SECONDS,
    maxConfidenceRatio: DEFAULT_MAX_CONFIDENCE_RATIO,
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
    if (arg === '--rpc-url') {
      options.rpcUrl = argv[++i] || '';
      continue;
    }
    if (arg === '--program-id') {
      options.programId = argv[++i] || '';
      continue;
    }
    if (arg === '--api-base-url') {
      options.apiBaseUrl = argv[++i] || '';
      continue;
    }
    if (arg === '--registry-source') {
      const value = argv[++i] as RegistrySource | undefined;
      if (!value || !['chain', 'api', 'both', 'none'].includes(value)) {
        throw new Error(`Invalid --registry-source value: ${value || '(missing)'}`);
      }
      options.registrySource = value;
      continue;
    }
    if (arg === '--allow-missing-registry') {
      options.allowMissingRegistry = true;
      continue;
    }
    if (arg === '--skip-feed-health-check') {
      options.checkFeedHealth = false;
      continue;
    }
    if (arg === '--skip-env-parity') {
      options.enforceEnvParity = false;
      continue;
    }
    if (arg === '--max-feed-age-seconds') {
      const value = Number(argv[++i]);
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`Invalid --max-feed-age-seconds value: ${value}`);
      }
      options.maxFeedAgeSeconds = value;
      continue;
    }
    if (arg === '--max-confidence-ratio') {
      const value = Number(argv[++i]);
      if (!Number.isFinite(value) || value < 0 || value >= 1) {
        throw new Error(`Invalid --max-confidence-ratio value: ${value}`);
      }
      options.maxConfidenceRatio = value;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function addCheck(
  checks: CheckResult[],
  nextCheck: Omit<CheckResult, 'ok'> & { ok?: boolean }
): void {
  checks.push({
    ok: nextCheck.ok ?? true,
    ...nextCheck,
  });
}

function parsePythReceiverFeed(accountData: Buffer): ParsedFeedData {
  let cursor = 0;
  if (accountData.length < 8 + 32 + 1 + 32 + 8 + 8 + 4 + 8) {
    throw new Error('Pyth receiver account data is too small');
  }

  cursor += 8; // account discriminator
  cursor += 32; // write authority
  const verificationVariant = accountData.readUInt8(cursor);
  cursor += 1;
  if (verificationVariant === 0) {
    cursor += 1; // partial verification signature count
  } else if (verificationVariant !== 1) {
    throw new Error('Unsupported pyth verification variant');
  }

  cursor += 32; // feed_id
  const aggregatePrice = Number(accountData.readBigInt64LE(cursor));
  cursor += 8;
  const confRaw = Number(accountData.readBigUInt64LE(cursor));
  cursor += 8;
  const exponent = accountData.readInt32LE(cursor);
  cursor += 4;
  const publishTime = Number(accountData.readBigInt64LE(cursor));

  const price = aggregatePrice * Math.pow(10, exponent);
  const conf = confRaw * Math.pow(10, exponent);
  return {
    source: 'pyth_receiver',
    price,
    conf,
    exponent,
    publishTime,
  };
}

function parseMockProgramFeed(accountData: Buffer): ParsedFeedData {
  const minLength = 8 + 32 + 8 + 8 + 4 + 8;
  if (accountData.length < minLength) {
    throw new Error('Mock oracle account data is too small');
  }

  let cursor = 0;
  cursor += 8; // discriminator
  cursor += 32; // authority
  cursor += 8; // feed_seed
  const priceRaw = Number(accountData.readBigInt64LE(cursor));
  cursor += 8;
  const exponent = accountData.readInt32LE(cursor);
  cursor += 4;
  const publishTime = Number(accountData.readBigInt64LE(cursor));

  const price = priceRaw * Math.pow(10, exponent);
  return {
    source: 'mock_program',
    price,
    conf: 0,
    exponent,
    publishTime,
  };
}

async function fetchRegistryFromChain(
  connection: Connection,
  programId: PublicKey
): Promise<{ entries: RegistryEntry[]; missing: boolean }> {
  const [registryPda] = PublicKey.findProgramAddressSync([Buffer.from('collateral_registry')], programId);
  const accountInfo = await connection.getAccountInfo(registryPda);
  if (!accountInfo) {
    return { entries: [], missing: true };
  }

  const parsed = parseCollateralRegistryAccount(accountInfo);
  const entries: RegistryEntry[] = parsed.collateral_types.map((entry) => ({
    mint: entry.mint,
    oraclePriceFeed: entry.oracle_price_feed,
    decimals: entry.decimals,
    liquidationBufferBps: entry.liquidation_buffer_bps,
    minCommittedFloorBps: entry.min_committed_floor_bps,
    isActive: entry.is_active,
  }));

  return { entries, missing: false };
}

async function fetchRegistryFromApi(apiBaseUrl: string): Promise<{ entries: RegistryEntry[]; missing: boolean }> {
  const normalized = apiBaseUrl.replace(/\/+$/, '');
  const response = await fetch(`${normalized}/api/collateral/registry`);
  if (response.status === 404) {
    return { entries: [], missing: true };
  }
  if (!response.ok) {
    throw new Error(`Registry API check failed with HTTP ${response.status}`);
  }

  const payload = (await response.json()) as {
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
  const types = payload.account?.collateral_types || [];
  const entries: RegistryEntry[] = types.map((entry) => ({
    mint: new PublicKey(entry.mint).toBase58(),
    oraclePriceFeed: new PublicKey(entry.oracle_price_feed).toBase58(),
    decimals: entry.decimals,
    liquidationBufferBps: entry.liquidation_buffer_bps,
    minCommittedFloorBps: entry.min_committed_floor_bps,
    isActive: entry.is_active,
  }));
  return { entries, missing: false };
}

function checkRegistryParity(
  checks: CheckResult[],
  registryLabel: 'chain' | 'api',
  manifestAssets: CollateralListingAsset[],
  registryEntries: RegistryEntry[],
  missingRegistry: boolean,
  allowMissingRegistry: boolean
): void {
  if (missingRegistry) {
    addCheck(checks, {
      scope: 'global',
      severity: allowMissingRegistry ? 'warning' : 'error',
      check: `${registryLabel}_registry_present`,
      ok: allowMissingRegistry,
      message: allowMissingRegistry
        ? `${registryLabel} collateral registry is missing (allowed by flag)`
        : `${registryLabel} collateral registry account is missing`,
    });
    return;
  }

  addCheck(checks, {
    scope: 'global',
    severity: 'error',
    check: `${registryLabel}_registry_present`,
    ok: true,
    message: `${registryLabel} collateral registry account is present`,
  });

  const registryByMint = new Map<string, RegistryEntry>();
  for (const entry of registryEntries) {
    registryByMint.set(entry.mint, entry);
  }

  for (const asset of manifestAssets) {
    const current = registryByMint.get(asset.mint);
    if (!current) {
      addCheck(checks, {
        scope: 'asset',
        severity: asset.isActive ? 'error' : 'warning',
        check: `${registryLabel}_registry_entry`,
        ok: !asset.isActive,
        symbol: asset.symbol,
        mint: asset.mint,
        message: asset.isActive
          ? `${registryLabel} registry is missing active manifest asset`
          : `${registryLabel} registry is missing inactive manifest asset (informational)`,
      });
      continue;
    }

    const matches =
      current.oraclePriceFeed === asset.oraclePriceFeed &&
      current.decimals === asset.decimals &&
      current.liquidationBufferBps === asset.liquidationBufferBps &&
      current.minCommittedFloorBps === asset.minCommittedFloorBps &&
      current.isActive === asset.isActive;

    addCheck(checks, {
      scope: 'asset',
      severity: 'error',
      check: `${registryLabel}_registry_parity`,
      ok: matches,
      symbol: asset.symbol,
      mint: asset.mint,
      message: matches ? `${registryLabel} registry matches manifest` : `${registryLabel} registry does not match manifest`,
      details: matches
        ? undefined
        : {
            manifest: asset,
            registry: current,
          },
    });
  }
}

async function run(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  const checks: CheckResult[] = [];
  const manifest = loadCollateralListingManifest(options.manifestPath);
  const envFeedByMint = parsePriceFeedConfig(process.env.PYTH_PRICE_FEEDS);

  const connection = new Connection(options.rpcUrl, 'confirmed');
  const normalizedProgramId = options.programId ? new PublicKey(options.programId).toBase58() : undefined;

  addCheck(checks, {
    scope: 'global',
    severity: 'error',
    check: 'manifest_loaded',
    ok: true,
    message: `Loaded manifest for ${manifest.environment} with ${manifest.assets.length} assets`,
  });

  for (const asset of manifest.assets) {
    const mintPubkey = new PublicKey(asset.mint);
    const oraclePubkey = new PublicKey(asset.oraclePriceFeed);

    const mintInfo = await connection.getAccountInfo(mintPubkey);
    if (!mintInfo) {
      addCheck(checks, {
        scope: 'asset',
        severity: 'error',
        check: 'mint_exists',
        ok: false,
        symbol: asset.symbol,
        mint: asset.mint,
        message: 'Mint account does not exist on cluster',
      });
      continue;
    }

    addCheck(checks, {
      scope: 'asset',
      severity: 'error',
      check: 'mint_exists',
      ok: true,
      symbol: asset.symbol,
      mint: asset.mint,
      message: 'Mint account exists',
    });

    const mintOwnerOk = mintInfo.owner.equals(TOKEN_PROGRAM_ID);
    addCheck(checks, {
      scope: 'asset',
      severity: 'error',
      check: 'mint_owner',
      ok: mintOwnerOk,
      symbol: asset.symbol,
      mint: asset.mint,
      message: mintOwnerOk
        ? 'Mint owner is SPL Token program'
        : `Mint owner is unexpected: ${mintInfo.owner.toBase58()}`,
    });

    try {
      const parsedMint = unpackMint(mintPubkey, mintInfo, mintInfo.owner);
      const decimalsMatch = parsedMint.decimals === asset.decimals;
      addCheck(checks, {
        scope: 'asset',
        severity: 'error',
        check: 'mint_decimals',
        ok: decimalsMatch,
        symbol: asset.symbol,
        mint: asset.mint,
        message: decimalsMatch
          ? `Mint decimals match (${asset.decimals})`
          : `Mint decimals mismatch: chain=${parsedMint.decimals}, manifest=${asset.decimals}`,
      });
    } catch (error) {
      addCheck(checks, {
        scope: 'asset',
        severity: 'error',
        check: 'mint_decimals',
        ok: false,
        symbol: asset.symbol,
        mint: asset.mint,
        message: `Failed to parse mint account: ${error instanceof Error ? error.message : 'Unknown error'}`,
      });
    }

    const oracleInfo = await connection.getAccountInfo(oraclePubkey);
    if (!oracleInfo) {
      addCheck(checks, {
        scope: 'asset',
        severity: 'error',
        check: 'oracle_exists',
        ok: false,
        symbol: asset.symbol,
        mint: asset.mint,
        message: 'Oracle price feed account does not exist',
      });
      continue;
    }

    addCheck(checks, {
      scope: 'asset',
      severity: 'error',
      check: 'oracle_exists',
      ok: true,
      symbol: asset.symbol,
      mint: asset.mint,
      message: 'Oracle account exists',
    });

    let parsedFeed: ParsedFeedData | null = null;
    const owner = oracleInfo.owner.toBase58();
    if (normalizedProgramId && owner === normalizedProgramId) {
      try {
        parsedFeed = parseMockProgramFeed(oracleInfo.data);
      } catch {
        parsedFeed = null;
      }
    }

    if (!parsedFeed) {
      try {
        parsedFeed = parsePythReceiverFeed(oracleInfo.data);
      } catch {
        parsedFeed = null;
      }
    }

    addCheck(checks, {
      scope: 'asset',
      severity: 'error',
      check: 'oracle_layout',
      ok: Boolean(parsedFeed),
      symbol: asset.symbol,
      mint: asset.mint,
      message: parsedFeed
        ? `Oracle layout parsed as ${parsedFeed.source} (owner=${owner})`
        : `Oracle account has unsupported layout or owner=${owner}`,
    });

    if (parsedFeed && options.checkFeedHealth) {
      const nowSeconds = Math.floor(Date.now() / 1000);
      const ageSeconds = Math.max(0, nowSeconds - parsedFeed.publishTime);
      const freshEnough = ageSeconds <= options.maxFeedAgeSeconds;
      addCheck(checks, {
        scope: 'asset',
        severity: 'error',
        check: 'oracle_freshness',
        ok: freshEnough,
        symbol: asset.symbol,
        mint: asset.mint,
        message: freshEnough
          ? `Oracle publish time is fresh (${ageSeconds}s old)`
          : `Oracle publish time is stale (${ageSeconds}s old, max ${options.maxFeedAgeSeconds}s)`,
      });

      const priceAbs = Math.abs(parsedFeed.price);
      const confRatio = priceAbs > 0 ? parsedFeed.conf / priceAbs : Number.POSITIVE_INFINITY;
      const confHealthy = confRatio <= options.maxConfidenceRatio;
      addCheck(checks, {
        scope: 'asset',
        severity: 'error',
        check: 'oracle_confidence',
        ok: confHealthy,
        symbol: asset.symbol,
        mint: asset.mint,
        message: confHealthy
          ? `Oracle confidence ratio is acceptable (${confRatio.toFixed(6)})`
          : `Oracle confidence ratio too high (${confRatio.toFixed(6)} > ${options.maxConfidenceRatio})`,
      });
    }

    if (options.enforceEnvParity) {
      const envFeed = envFeedByMint[asset.mint];
      addCheck(checks, {
        scope: 'asset',
        severity: 'error',
        check: 'env_mapping_present',
        ok: Boolean(envFeed),
        symbol: asset.symbol,
        mint: asset.mint,
        message: envFeed
          ? 'PYTH_PRICE_FEEDS contains mint mapping'
          : 'PYTH_PRICE_FEEDS is missing mapping for manifest mint',
      });
      if (envFeed) {
        const matches = envFeed === asset.oraclePriceFeed;
        addCheck(checks, {
          scope: 'asset',
          severity: 'error',
          check: 'env_mapping_matches',
          ok: matches,
          symbol: asset.symbol,
          mint: asset.mint,
          message: matches
            ? 'PYTH_PRICE_FEEDS mapping matches manifest'
            : `PYTH_PRICE_FEEDS mismatch: env=${envFeed} manifest=${asset.oraclePriceFeed}`,
        });
      }
    }
  }

  if (options.registrySource === 'chain' || options.registrySource === 'both') {
    if (!normalizedProgramId) {
      addCheck(checks, {
        scope: 'global',
        severity: 'error',
        check: 'chain_registry_program_id',
        ok: false,
        message: 'Program ID is required for chain registry parity checks',
      });
    } else {
      const chainRegistry = await fetchRegistryFromChain(connection, new PublicKey(normalizedProgramId));
      checkRegistryParity(
        checks,
        'chain',
        manifest.assets,
        chainRegistry.entries,
        chainRegistry.missing,
        options.allowMissingRegistry
      );
    }
  }

  if (options.registrySource === 'api' || options.registrySource === 'both') {
    if (!options.apiBaseUrl) {
      addCheck(checks, {
        scope: 'global',
        severity: 'error',
        check: 'api_registry_base_url',
        ok: false,
        message: 'API base URL is required for API registry parity checks',
      });
    } else {
      const apiRegistry = await fetchRegistryFromApi(options.apiBaseUrl);
      checkRegistryParity(
        checks,
        'api',
        manifest.assets,
        apiRegistry.entries,
        apiRegistry.missing,
        options.allowMissingRegistry
      );
    }
  }

  const failedErrors = checks.filter((check) => !check.ok && check.severity === 'error');
  const warningCount = checks.filter((check) => !check.ok && check.severity === 'warning').length;
  const output = {
    success: failedErrors.length === 0,
    manifestPath: options.manifestPath,
    environment: manifest.environment,
    options: {
      rpcUrl: options.rpcUrl,
      programId: normalizedProgramId || null,
      apiBaseUrl: options.apiBaseUrl || null,
      registrySource: options.registrySource,
      checkFeedHealth: options.checkFeedHealth,
      enforceEnvParity: options.enforceEnvParity,
      allowMissingRegistry: options.allowMissingRegistry,
      maxFeedAgeSeconds: options.maxFeedAgeSeconds,
      maxConfidenceRatio: options.maxConfidenceRatio,
    },
    summary: {
      assets: manifest.assets.length,
      totalChecks: checks.length,
      failedErrorChecks: failedErrors.length,
      warningChecks: warningCount,
    },
    checks,
  };

  console.log(JSON.stringify(output, null, 2));
  return output.success ? 0 : 1;
}

void run()
  .then((exitCode) => {
    process.exit(exitCode);
  })
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.log(
      JSON.stringify(
        {
          success: false,
          summary: {
            assets: 0,
            totalChecks: 0,
            failedErrorChecks: 1,
            warningChecks: 0,
          },
          checks: [
            {
              scope: 'global',
              severity: 'error',
              check: 'script_error',
              ok: false,
              message,
            },
          ],
        },
        null,
        2
      )
    );
    process.exit(1);
  });
