import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import type { Stendar } from "../target/types/stendar";
import { assert } from "chai";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createMint,
  getAccount,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  airdropSol,
  deriveFrontendOperatorPda,
  hasIdlInstruction,
  isValidSplMint,
  refundTrackedKeypairs,
  registerFrontendOperator,
  asTestProgram,
  toBn,
  u64ToLeBytes,
} from "./test_helpers.ts";

const LAMPORTS_PER_SOL = anchor.web3.LAMPORTS_PER_SOL;


function bnToBigInt(value: anchor.BN): bigint {
  return BigInt(value.toString());
}


function encodePoolName(name: string): number[] {
  const buf = Buffer.alloc(32);
  buf.write(name.slice(0, 32), "utf8");
  return Array.from(buf);
}

function decodeFixedName(value: number[] | Uint8Array): string {
  return Buffer.from(value).toString("utf8").replace(/\0+$/g, "").trim();
}

function parseErrorMessage(error: unknown): string {
  const anyErr = error as {
    error?: { errorCode?: { code?: string }; errorMessage?: string };
    logs?: string[];
    message?: string;
    toString?: () => string;
  };
  return (
    anyErr?.error?.errorCode?.code ??
    anyErr?.error?.errorMessage ??
    anyErr?.logs?.join(" ") ??
    anyErr?.message ??
    anyErr?.toString?.() ??
    String(error)
  );
}

async function expectTxFailure(
  promise: Promise<unknown>,
  expectedMessagePart?: string,
): Promise<void> {
  try {
    await promise;
    assert.fail("Expected transaction to fail");
  } catch (error) {
    const message = parseErrorMessage(error);
    if (expectedMessagePart) {
      assert.include(
        message,
        expectedMessagePart,
        `expected error containing '${expectedMessagePart}', got: ${message}`,
      );
    }
  }
}

describe("Pool lifecycle", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const connection = provider.connection;
  const payer = (provider.wallet as anchor.Wallet & { payer: Keypair }).payer;

  const workspaceProgram = anchor.workspace.Stendar as Program<Stendar>;
  const programId = new PublicKey(
    process.env.STENDAR_PROGRAM_ID ??
      process.env.SOLANA_PROGRAM_ID ??
      workspaceProgram.programId.toBase58(),
  );
  const program = asTestProgram(new Program<Stendar>(
    {
      ...(workspaceProgram.idl as Record<string, unknown>),
      address: programId.toBase58(),
    } as Stendar,
    provider,
  ));
  const hasRegisterFrontendInstruction = hasIdlInstruction(
    workspaceProgram.idl as { instructions?: Array<{ name?: string }> },
    "register_frontend",
    "registerFrontend",
  );

  const [statePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("global_state")],
    program.programId,
  );
  const [treasuryPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("treasury")],
    program.programId,
  );
  const [collateralRegistryPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("collateral_registry")],
    program.programId,
  );

  let poolSeedCounter = 71_000;
  let contractSeedCounter = 72_000;
  let oracleSeedCounter = 73_000;

  let usdcMint: PublicKey;
  let collateralMint: PublicKey;
  let treasuryUsdcAta: PublicKey;
  let canRunContractFlows = true;
  let registeredOracleFeed: PublicKey;

  function nextPoolSeed(): anchor.BN {
    poolSeedCounter += 1;
    return toBn(poolSeedCounter);
  }

  function nextContractSeed(): anchor.BN {
    contractSeedCounter += 1;
    return toBn(contractSeedCounter);
  }

  function nextOracleSeed(): anchor.BN {
    oracleSeedCounter += 1;
    return toBn(oracleSeedCounter);
  }

  function deriveOperatorAuth(operator: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("pool_operator"), operator.toBuffer()],
      program.programId,
    )[0];
  }

  function derivePool(operator: PublicKey, poolSeed: anchor.BN): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("pool"), operator.toBuffer(), u64ToLeBytes(poolSeed)],
      program.programId,
    )[0];
  }

  function derivePoolDeposit(pool: PublicKey, depositor: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("pool_deposit"), pool.toBuffer(), depositor.toBuffer()],
      program.programId,
    )[0];
  }

  function deriveContribution(contract: PublicKey, lender: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("contribution"), contract.toBuffer(), lender.toBuffer()],
      program.programId,
    )[0];
  }

  function deriveEscrow(contract: PublicKey, lender: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), contract.toBuffer(), lender.toBuffer()],
      program.programId,
    )[0];
  }

  function deriveFrontendOperator(operator: PublicKey): PublicKey {
    return deriveFrontendOperatorPda(operator, program.programId);
  }

  function deriveMockOracle(feedSeed: anchor.BN): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("mock_oracle_price_feed"), u64ToLeBytes(feedSeed)],
      program.programId,
    )[0];
  }

  async function getNowTs(): Promise<number> {
    const slot = await connection.getSlot("confirmed");
    const blockTime = await connection.getBlockTime(slot);
    return blockTime ?? Math.floor(Date.now() / 1000);
  }

  async function ensurePlatformInitialized(): Promise<void> {
    const stateInfo = await connection.getAccountInfo(statePda);
    if (!stateInfo) {
      await program.methods
        .initialize()
        .accountsPartial({
          state: statePda,
          authority: provider.wallet.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    }

    const treasuryInfo = await connection.getAccountInfo(treasuryPda);
    if (!treasuryInfo) {
      if (!usdcMint) {
        usdcMint = await createMint(connection, payer, provider.wallet.publicKey, null, 6);
      }
      await program.methods
        .initializeTreasury(provider.wallet.publicKey, usdcMint)
        .accountsPartial({
          treasury: treasuryPda,
          state: statePda,
          authority: provider.wallet.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    }
  }

  async function ensureCollateralRegistry(oraclePriceFeed: PublicKey): Promise<void> {
    const registryInfo = await connection.getAccountInfo(collateralRegistryPda);
    if (registryInfo === null) {
      await program.methods
        .initializeCollateralRegistry()
        .accountsPartial({
          authority: provider.wallet.publicKey,
          state: statePda,
          collateralRegistry: collateralRegistryPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    }

    await program.methods
      .resetCollateralRegistry()
      .accountsPartial({
        authority: provider.wallet.publicKey,
        state: statePda,
        collateralRegistry: collateralRegistryPda,
      })
      .rpc();

    await program.methods
      .resetTreasuryUsdcMint(usdcMint)
      .accountsPartial({
        authority: provider.wallet.publicKey,
        state: statePda,
        treasury: treasuryPda,
      })
      .rpc();

    await program.methods
      .updateBotAuthority()
      .accountsPartial({
        treasury: treasuryPda,
        authority: provider.wallet.publicKey,
        newBotAuthority: provider.wallet.publicKey,
      })
      .rpc();

    const registry = await program.account.collateralRegistry.fetch(
      collateralRegistryPda,
    );
    const exists = registry.collateralTypes.some((entry: any) =>
      (entry.mint as PublicKey).equals(collateralMint),
    );
    if (!exists) {
      try {
        await program.methods
          .addCollateralType(oraclePriceFeed, 8, 500, 11_000)
          .accountsPartial({
            authority: provider.wallet.publicKey,
            state: statePda,
            collateralRegistry: collateralRegistryPda,
            collateralMint,
            oraclePriceFeed,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
      } catch (error) {
        if (parseErrorMessage(error).includes("CollateralRegistryFull")) {
          canRunContractFlows = false;
          return;
        }
        throw error;
      }
    }
  }

  async function upsertMockOraclePrice(seed: anchor.BN, price: bigint): Promise<PublicKey> {
    const mockOracle = deriveMockOracle(seed);
    const publishTime = await getNowTs();
    const existing = await connection.getAccountInfo(mockOracle);
    if (existing === null) {
      await program.methods
        .initializeMockOraclePriceFeed(seed, toBn(price), -8, toBn(publishTime))
        .accountsPartial({
          authority: provider.wallet.publicKey,
          state: statePda,
          mockOraclePriceFeed: mockOracle,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    } else {
      await program.methods
        .setMockOraclePriceFeed(toBn(price), -8, toBn(publishTime))
        .accountsPartial({
          authority: provider.wallet.publicKey,
          state: statePda,
          mockOraclePriceFeed: mockOracle,
        })
        .rpc();
    }
    return mockOracle;
  }

  async function authorizeOperator(operator: Keypair): Promise<PublicKey> {
    const operatorAuth = deriveOperatorAuth(operator.publicKey);
    await program.methods
      .authorizePoolOperator()
      .accountsPartial({
        state: statePda,
        authority: provider.wallet.publicKey,
        operatorAuth,
        operator: operator.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    return operatorAuth;
  }

  async function registerFrontend(operator: Keypair): Promise<PublicKey> {
    return registerFrontendOperator(connection, program.programId, operator);
  }

  async function createPoolForOperator(params: {
    operator: Keypair;
    operatorAuth: PublicKey;
    rateBps?: number;
    capacity?: bigint;
    minimumDeposit?: bigint;
    withdrawalQueueEnabled?: boolean;
    allowedLoanType?: number;
    minLtvBps?: number;
    maxTermDays?: number;
    poolName?: string;
  }): Promise<{ pool: PublicKey; poolVault: PublicKey; poolSeed: anchor.BN }> {
    const poolSeed = nextPoolSeed();
    const pool = derivePool(params.operator.publicKey, poolSeed);
    const poolVault = getAssociatedTokenAddressSync(usdcMint, pool, true);
    await program.methods
      .createPool(
        poolSeed,
        encodePoolName(params.poolName ?? "pool"),
        params.rateBps ?? 1_200,
        toBn(params.capacity ?? 0n),
        toBn(params.minimumDeposit ?? 10_000n),
        params.withdrawalQueueEnabled ?? false,
        params.allowedLoanType ?? 0,
        params.minLtvBps ?? 0,
        params.maxTermDays ?? 0,
      )
      .accountsPartial({
        operator: params.operator.publicKey,
        operatorAuth: params.operatorAuth,
        pool,
        poolVault,
        state: statePda,
        usdcMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([params.operator])
      .rpc();
    return { pool, poolVault, poolSeed };
  }

  async function createDebtContractFixture(targetAmount: bigint): Promise<{
    borrower: Keypair;
    contract: PublicKey;
    operationsFund: PublicKey;
    contractUsdcAta: PublicKey;
    borrowerUsdcAta: PublicKey;
    borrowerCollateralAta: PublicKey;
    contractCollateralAta: PublicKey;
  }> {
    const borrower = Keypair.generate();
    await airdropSol(connection, borrower, 0.1);

    const contractSeed = nextContractSeed();
    const [contract] = PublicKey.findProgramAddressSync(
      [Buffer.from("debt_contract"), borrower.publicKey.toBuffer(), u64ToLeBytes(contractSeed)],
      program.programId,
    );
    const [operationsFund] = PublicKey.findProgramAddressSync(
      [Buffer.from("operations_fund"), contract.toBuffer()],
      program.programId,
    );

    const borrowerCollateralAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      collateralMint,
      borrower.publicKey,
    );
    const contractCollateralAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      collateralMint,
      contract,
      true,
    );
    const borrowerUsdcAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      usdcMint,
      borrower.publicKey,
    );
    const contractUsdcAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      usdcMint,
      contract,
      true,
    );

    await mintTo(
      connection,
      payer,
      collateralMint,
      borrowerCollateralAta.address,
      provider.wallet.publicKey,
      8_000_000_000n,
    );
    await mintTo(
      connection,
      payer,
      usdcMint,
      borrowerUsdcAta.address,
      provider.wallet.publicKey,
      targetAmount + 5_000_000n,
    );

    const oraclePriceFeed = registeredOracleFeed;
    await program.methods
      .setMockOraclePriceFeed(toBn(200_000_000n), -8, toBn(await getNowTs()))
      .accountsPartial({
        authority: provider.wallet.publicKey,
        state: statePda,
        mockOraclePriceFeed: oraclePriceFeed,
      })
      .rpc();

    await program.methods
      .createDebtContract(
        contractSeed,
        14,
        toBn(targetAmount),
        toBn(900),
        30,
        toBn(6_000_000_000n),
        { demand: {} },
        toBn(11_000),
        11_000,
        { outstandingBalance: {} },
        { noFixedPayment: {} },
        { weekly: {} },
        null,
        true,
        false,
        0,
        { manual: {} },
        { public: {} },
      )
      .accountsPartial({
        contract,
        operationsFund,
        state: statePda,
        treasury: treasuryPda,
        borrower: borrower.publicKey,
        systemProgram: SystemProgram.programId,
        collateralRegistry: collateralRegistryPda,
        collateralMint,
        borrowerCollateralAta: borrowerCollateralAta.address,
        contractCollateralAta: contractCollateralAta.address,
        priceFeedAccount: oraclePriceFeed,
        usdcMint,
        contractUsdcAta: contractUsdcAta.address,
        borrowerUsdcAta: borrowerUsdcAta.address,
        treasuryUsdcAccount: treasuryUsdcAta,
        frontendOperator: null,
        frontendUsdcAta: null,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .signers([borrower])
      .rpc();

    return {
      borrower,
      contract,
      operationsFund,
      contractUsdcAta: contractUsdcAta.address,
      borrowerUsdcAta: borrowerUsdcAta.address,
      borrowerCollateralAta: borrowerCollateralAta.address,
      contractCollateralAta: contractCollateralAta.address,
    };
  }

  before(async () => {
    await ensurePlatformInitialized();

    await program.methods
      .updateFeeRates(0, 0, null, null, null)
      .accountsPartial({ state: statePda, authority: provider.wallet.publicKey })
      .rpc();

    try {
      const treasury = await program.account.treasury.fetch(treasuryPda);
      if (!treasury.usdcMint.equals(PublicKey.default) && await isValidSplMint(connection, treasury.usdcMint)) {
        usdcMint = treasury.usdcMint;
      } else {
        usdcMint = await createMint(connection, payer, provider.wallet.publicKey, null, 6);
      }
    } catch {
      usdcMint = await createMint(connection, payer, provider.wallet.publicKey, null, 6);
    }
    collateralMint = await createMint(connection, payer, provider.wallet.publicKey, null, 8);
    treasuryUsdcAta = (
      await getOrCreateAssociatedTokenAccount(connection, payer, usdcMint, treasuryPda, true)
    ).address;

    await program.methods
      .updateBotAuthority()
      .accountsPartial({
        treasury: treasuryPda,
        authority: provider.wallet.publicKey,
        newBotAuthority: provider.wallet.publicKey,
      })
      .rpc();

    const hasMockOracleTestInstructions =
      typeof program.methods.initializeMockOraclePriceFeed === "function" &&
      typeof program.methods.setMockOraclePriceFeed === "function";
    if (!hasMockOracleTestInstructions) {
      canRunContractFlows = false;
      return;
    }

    const oracleSeed = nextOracleSeed();
    const oraclePriceFeed = await upsertMockOraclePrice(oracleSeed, 200_000_000n);
    registeredOracleFeed = oraclePriceFeed;
    await ensureCollateralRegistry(oraclePriceFeed);

  });

  after(async () => {
    await refundTrackedKeypairs(connection);
  });

  beforeEach(async () => {
    if (typeof program.methods.setMockOraclePriceFeed !== "function") {
      return;
    }
    const freshPublishTime = new anchor.BN(Math.floor(Date.now() / 1000));
    await program.methods
      .setMockOraclePriceFeed(
        toBn(200_000_000n),
        -8,
        freshPublishTime,
      )
      .accountsPartial({
        authority: provider.wallet.publicKey,
        state: statePda,
        mockOraclePriceFeed: registeredOracleFeed,
      })
      .rpc();
  });

  it("handles operator authorization and revocation", async () => {
    const unauthorizedAuthority = Keypair.generate();
    await airdropSol(connection, unauthorizedAuthority, 0.01);
    const unauthorizedOperator = Keypair.generate();
    const unauthorizedAuthPda = deriveOperatorAuth(unauthorizedOperator.publicKey);

    await expectTxFailure(
      program.methods
        .authorizePoolOperator()
        .accountsPartial({
          state: statePda,
          authority: unauthorizedAuthority.publicKey,
          operatorAuth: unauthorizedAuthPda,
          operator: unauthorizedOperator.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([unauthorizedAuthority])
        .rpc(),
      "InvalidAuthority",
    );

    const operator = Keypair.generate();
    await airdropSol(connection, operator, 0.05);
    const operatorAuth = await authorizeOperator(operator);
    const operatorAuthAccount = await program.account.authorizedPoolOperator.fetch(operatorAuth);
    assert.equal(operatorAuthAccount.operator.toBase58(), operator.publicKey.toBase58());
    assert.equal(operatorAuthAccount.authorizedBy.toBase58(), provider.wallet.publicKey.toBase58());

    await program.methods
      .revokePoolOperator()
      .accountsPartial({
        state: statePda,
        authority: provider.wallet.publicKey,
        operatorAuth,
        operator: operator.publicKey,
      })
      .rpc();

    const closed = await connection.getAccountInfo(operatorAuth);
    assert.isNull(closed, "operator auth PDA should be closed after revoke");
  });

  it("updates pool and operator names with operator-only authorization", async () => {
    const operator = Keypair.generate();
    const attacker = Keypair.generate();
    await Promise.all([
      airdropSol(connection, operator, 0.05),
      airdropSol(connection, attacker, 0.05),
    ]);

    const operatorAuth = await authorizeOperator(operator);
    const { pool } = await createPoolForOperator({
      operator,
      operatorAuth,
      poolName: "initial-name",
    });

    await program.methods
      .updatePoolName(encodePoolName("renamed-pool"))
      .accountsPartial({
        operator: operator.publicKey,
        pool,
      })
      .signers([operator])
      .rpc();

    const renamedPool = await program.account.poolState.fetch(pool);
    assert.equal(decodeFixedName(renamedPool.name), "renamed-pool");

    await expectTxFailure(
      program.methods
        .updatePoolName(encodePoolName("attacker-name"))
        .accountsPartial({
          operator: attacker.publicKey,
          pool,
        })
        .signers([attacker])
        .rpc(),
      "InvalidPoolOperator",
    );

    await program.methods
      .updateOperatorName(encodePoolName("Solend Labs"))
      .accountsPartial({
        operator: operator.publicKey,
        operatorAuth,
      })
      .signers([operator])
      .rpc();

    const operatorAccount = await program.account.authorizedPoolOperator.fetch(operatorAuth);
    assert.equal(decodeFixedName(operatorAccount.operatorName), "Solend Labs");

    await expectTxFailure(
      program.methods
        .updateOperatorName(encodePoolName("Imposter Org"))
        .accountsPartial({
          operator: attacker.publicKey,
          operatorAuth,
        })
        .signers([attacker])
        .rpc(),
      "ConstraintSeeds",
    );
  });

  it("covers pool lifecycle and deposit/withdraw guardrails", async () => {
    const unauthorizedOperator = Keypair.generate();
    await airdropSol(connection, unauthorizedOperator, 0.01);
    const unauthorizedOperatorAuth = deriveOperatorAuth(unauthorizedOperator.publicKey);
    const unauthorizedPoolSeed = nextPoolSeed();
    const unauthorizedPool = derivePool(unauthorizedOperator.publicKey, unauthorizedPoolSeed);
    const unauthorizedPoolVault = getAssociatedTokenAddressSync(usdcMint, unauthorizedPool, true);

    await expectTxFailure(
      program.methods
        .createPool(
          unauthorizedPoolSeed,
          encodePoolName("unauth"),
          1_200,
          toBn(100_000_000n),
          toBn(10_000n),
          false,
          0,
          0,
          0,
        )
        .accountsPartial({
          operator: unauthorizedOperator.publicKey,
          operatorAuth: unauthorizedOperatorAuth,
          pool: unauthorizedPool,
          poolVault: unauthorizedPoolVault,
          state: statePda,
          usdcMint,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([unauthorizedOperator])
        .rpc(),
    );

    const operator = Keypair.generate();
    await airdropSol(connection, operator, 0.05);
    const operatorAuth = await authorizeOperator(operator);
    const { pool, poolVault } = await createPoolForOperator({
      operator,
      operatorAuth,
      rateBps: 1_500,
      capacity: 200_000_000n,
      minimumDeposit: 10_000n,
      withdrawalQueueEnabled: false,
      poolName: "main-pool",
    });

    const poolAccount = await program.account.poolState.fetch(pool);
    assert.equal(poolAccount.operator.toBase58(), operator.publicKey.toBase58());
    assert.equal(poolAccount.rateBps, 1_500);
    assert.equal(poolAccount.capacity.toString(), "200000000");
    assert.equal(poolAccount.currentTotalDeposits.toString(), "0");
    assert.equal(poolAccount.numDepositors, 0);
    assert.equal(poolAccount.allowedLoanType, 0);
    assert.equal(poolAccount.minLtvBps, 0);
    assert.equal(poolAccount.maxTermDays, 0);

    await program.methods
      .pausePool()
      .accountsPartial({ operator: operator.publicKey, pool })
      .signers([operator])
      .rpc();

    const pausedDepositor = Keypair.generate();
    await airdropSol(connection, pausedDepositor, 0.05);
    const pausedDepositorAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      usdcMint,
      pausedDepositor.publicKey,
    );
    await mintTo(
      connection,
      payer,
      usdcMint,
      pausedDepositorAta.address,
      provider.wallet.publicKey,
      1_000_000n,
    );
    const pausedPoolDeposit = derivePoolDeposit(pool, pausedDepositor.publicKey);
    await expectTxFailure(
      program.methods
        .depositToPool(toBn(100_000n))
        .accountsPartial({
          depositor: pausedDepositor.publicKey,
          pool,
          state: statePda,
          treasury: treasuryPda,
          poolDeposit: pausedPoolDeposit,
          poolVault,
          depositorUsdcAta: pausedDepositorAta.address,
          treasuryUsdcAccount: treasuryUsdcAta,
          frontendOperator: null,
          frontendUsdcAta: null,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([pausedDepositor])
        .rpc(),
      "PoolPaused",
    );

    await program.methods
      .resumePool()
      .accountsPartial({ operator: operator.publicKey, pool })
      .signers([operator])
      .rpc();

    const depositor = Keypair.generate();
    await airdropSol(connection, depositor, 0.05);
    const depositorAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      usdcMint,
      depositor.publicKey,
    );
    await mintTo(
      connection,
      payer,
      usdcMint,
      depositorAta.address,
      provider.wallet.publicKey,
      120_000_000n,
    );
    const poolDeposit = derivePoolDeposit(pool, depositor.publicKey);

    await program.methods
      .depositToPool(toBn(50_000_000n))
      .accountsPartial({
        depositor: depositor.publicKey,
        pool,
        state: statePda,
        treasury: treasuryPda,
        poolDeposit,
        poolVault,
        depositorUsdcAta: depositorAta.address,
        treasuryUsdcAccount: treasuryUsdcAta,
        frontendOperator: null,
        frontendUsdcAta: null,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([depositor])
      .rpc();

    await program.methods
      .depositToPool(toBn(25_000_000n))
      .accountsPartial({
        depositor: depositor.publicKey,
        pool,
        state: statePda,
        treasury: treasuryPda,
        poolDeposit,
        poolVault,
        depositorUsdcAta: depositorAta.address,
        treasuryUsdcAccount: treasuryUsdcAta,
        frontendOperator: null,
        frontendUsdcAta: null,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([depositor])
      .rpc();

    let updatedPool = await program.account.poolState.fetch(pool);
    assert.equal(updatedPool.currentTotalDeposits.toString(), "75000000");
    assert.equal(updatedPool.numDepositors, 1);

    await program.methods
      .withdrawFromPool(toBn(20_000_000n))
      .accountsPartial({
        depositor: depositor.publicKey,
        pool,
        poolDeposit,
        poolVault,
        depositorUsdcAta: depositorAta.address,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([depositor])
      .rpc();

    await program.methods
      .withdrawFromPool(toBn(55_000_000n))
      .accountsPartial({
        depositor: depositor.publicKey,
        pool,
        poolDeposit,
        poolVault,
        depositorUsdcAta: depositorAta.address,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([depositor])
      .rpc();

    updatedPool = await program.account.poolState.fetch(pool);
    const updatedDeposit = await program.account.poolDeposit.fetch(poolDeposit);
    assert.equal(updatedPool.currentTotalDeposits.toString(), "0");
    assert.equal(updatedPool.numDepositors, 0);
    assert.equal(updatedDeposit.depositAmount.toString(), "0");

    await expectTxFailure(
      program.methods
        .withdrawFromPool(toBn(1))
        .accountsPartial({
          depositor: depositor.publicKey,
          pool,
          poolDeposit,
          poolVault,
          depositorUsdcAta: depositorAta.address,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([depositor])
        .rpc(),
    );

    const belowMinimumDepositor = Keypair.generate();
    await airdropSol(connection, belowMinimumDepositor, 0.05);
    const belowMinimumAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      usdcMint,
      belowMinimumDepositor.publicKey,
    );
    await mintTo(
      connection,
      payer,
      usdcMint,
      belowMinimumAta.address,
      provider.wallet.publicKey,
      100_000n,
    );
    const belowMinimumPoolDeposit = derivePoolDeposit(pool, belowMinimumDepositor.publicKey);
    await expectTxFailure(
      program.methods
        .depositToPool(toBn(1_000n))
        .accountsPartial({
          depositor: belowMinimumDepositor.publicKey,
          pool,
          state: statePda,
          treasury: treasuryPda,
          poolDeposit: belowMinimumPoolDeposit,
          poolVault,
          depositorUsdcAta: belowMinimumAta.address,
          treasuryUsdcAccount: treasuryUsdcAta,
          frontendOperator: null,
          frontendUsdcAta: null,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([belowMinimumDepositor])
        .rpc(),
      "PoolDepositBelowMinimum",
    );

    const capacityDepositor = Keypair.generate();
    await airdropSol(connection, capacityDepositor, 0.05);
    const capacityAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      usdcMint,
      capacityDepositor.publicKey,
    );
    await mintTo(
      connection,
      payer,
      usdcMint,
      capacityAta.address,
      provider.wallet.publicKey,
      500_000_000n,
    );
    const capacityPoolDeposit = derivePoolDeposit(pool, capacityDepositor.publicKey);
    await expectTxFailure(
      program.methods
        .depositToPool(toBn(250_000_000n))
        .accountsPartial({
          depositor: capacityDepositor.publicKey,
          pool,
          state: statePda,
          treasury: treasuryPda,
          poolDeposit: capacityPoolDeposit,
          poolVault,
          depositorUsdcAta: capacityAta.address,
          treasuryUsdcAccount: treasuryUsdcAta,
          frontendOperator: null,
          frontendUsdcAta: null,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([capacityDepositor])
        .rpc(),
      "PoolCapacityExceeded",
    );

    await program.methods
      .closePool()
      .accountsPartial({ operator: operator.publicKey, pool })
      .signers([operator])
      .rpc();
  });

  it("sets pool yield preference with validation and auth checks", async () => {
    const operator = Keypair.generate();
    const depositor = Keypair.generate();
    const outsider = Keypair.generate();
    await Promise.all([
      airdropSol(connection, operator, 0.05),
      airdropSol(connection, depositor, 0.05),
      airdropSol(connection, outsider, 0.05),
    ]);

    const operatorAuth = await authorizeOperator(operator);
    const { pool, poolVault } = await createPoolForOperator({
      operator,
      operatorAuth,
      rateBps: 1_000,
      capacity: 0n,
      minimumDeposit: 10_000n,
      poolName: "yield-preference",
    });

    const depositorAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      usdcMint,
      depositor.publicKey,
    );
    await mintTo(
      connection,
      payer,
      usdcMint,
      depositorAta.address,
      provider.wallet.publicKey,
      50_000_000n,
    );

    const poolDeposit = derivePoolDeposit(pool, depositor.publicKey);
    await program.methods
      .depositToPool(toBn(20_000_000n))
      .accountsPartial({
        depositor: depositor.publicKey,
        pool,
        state: statePda,
        treasury: treasuryPda,
        poolDeposit,
        poolVault,
        depositorUsdcAta: depositorAta.address,
        treasuryUsdcAccount: treasuryUsdcAta,
        frontendOperator: null,
        frontendUsdcAta: null,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([depositor])
      .rpc();

    await program.methods
      .setYieldPreference(1)
      .accountsPartial({
        depositor: depositor.publicKey,
        pool,
        poolDeposit,
      })
      .signers([depositor])
      .rpc();

    // No-op update should still succeed and emit an event.
    await program.methods
      .setYieldPreference(1)
      .accountsPartial({
        depositor: depositor.publicKey,
        pool,
        poolDeposit,
      })
      .signers([depositor])
      .rpc();

    const poolDepositInfoAfterClaimPreference = await connection.getAccountInfo(poolDeposit);
    assert.isNotNull(poolDepositInfoAfterClaimPreference, "pool deposit account should exist");
    const preferenceOffset = 8 + 32 + 32 + 8 + 8 + 8 + 8 + 1 + 8 + 8 + 8 + 32;
    assert.equal(
      poolDepositInfoAfterClaimPreference!.data[preferenceOffset],
      1,
      "yield preference byte should be claim (1)",
    );

    await program.methods
      .setYieldPreference(0)
      .accountsPartial({
        depositor: depositor.publicKey,
        pool,
        poolDeposit,
      })
      .signers([depositor])
      .rpc();

    const poolDepositInfoAfterCompoundPreference = await connection.getAccountInfo(poolDeposit);
    assert.isNotNull(poolDepositInfoAfterCompoundPreference, "pool deposit account should exist");
    assert.equal(
      poolDepositInfoAfterCompoundPreference!.data[preferenceOffset],
      0,
      "yield preference byte should be compound (0)",
    );

    await expectTxFailure(
      program.methods
        .setYieldPreference(2)
        .accountsPartial({
          depositor: depositor.publicKey,
          pool,
          poolDeposit,
        })
        .signers([depositor])
        .rpc(),
      "InvalidYieldPreference",
    );

    await expectTxFailure(
      program.methods
        .setYieldPreference(1)
        .accountsPartial({
          depositor: outsider.publicKey,
          pool,
          poolDeposit,
        })
        .signers([outsider])
        .rpc(),
      "ConstraintSeeds",
    );
  });

  it("accrues yield proportionally across depositors", async () => {
    const operator = Keypair.generate();
    await airdropSol(connection, operator, 0.05);
    const operatorAuth = await authorizeOperator(operator);
    const { pool, poolVault } = await createPoolForOperator({
      operator,
      operatorAuth,
      rateBps: 10_000,
      capacity: 0n,
      minimumDeposit: 10_000n,
      poolName: "yield-pool",
    });

    const depositorA = Keypair.generate();
    const depositorB = Keypair.generate();
    await Promise.all([
      airdropSol(connection, depositorA, 0.05),
      airdropSol(connection, depositorB, 0.05),
    ]);

    const depositorAAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      usdcMint,
      depositorA.publicKey,
    );
    const depositorBAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      usdcMint,
      depositorB.publicKey,
    );
    await mintTo(
      connection,
      payer,
      usdcMint,
      depositorAAta.address,
      provider.wallet.publicKey,
      100_000_000n,
    );
    await mintTo(
      connection,
      payer,
      usdcMint,
      depositorBAta.address,
      provider.wallet.publicKey,
      200_000_000n,
    );

    const poolDepositA = derivePoolDeposit(pool, depositorA.publicKey);
    const poolDepositB = derivePoolDeposit(pool, depositorB.publicKey);

    await program.methods
      .depositToPool(toBn(50_000_000n))
      .accountsPartial({
        depositor: depositorA.publicKey,
        pool,
        state: statePda,
        treasury: treasuryPda,
        poolDeposit: poolDepositA,
        poolVault,
        depositorUsdcAta: depositorAAta.address,
        treasuryUsdcAccount: treasuryUsdcAta,
        frontendOperator: null,
        frontendUsdcAta: null,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([depositorA])
      .rpc();
    await program.methods
      .depositToPool(toBn(100_000_000n))
      .accountsPartial({
        depositor: depositorB.publicKey,
        pool,
        state: statePda,
        treasury: treasuryPda,
        poolDeposit: poolDepositB,
        poolVault,
        depositorUsdcAta: depositorBAta.address,
        treasuryUsdcAccount: treasuryUsdcAta,
        frontendOperator: null,
        frontendUsdcAta: null,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([depositorB])
      .rpc();

    await new Promise((resolve) => setTimeout(resolve, 1_500));

    await program.methods
      .claimPoolYield()
      .accountsPartial({
        depositor: depositorA.publicKey,
        state: statePda,
        treasury: treasuryPda,
        pool,
        poolDeposit: poolDepositA,
        poolVault,
        depositorUsdcAta: depositorAAta.address,
        treasuryUsdcAccount: treasuryUsdcAta,
        frontendOperator: null,
        frontendUsdcAta: null,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([depositorA])
      .rpc();
    await program.methods
      .claimPoolYield()
      .accountsPartial({
        depositor: depositorB.publicKey,
        state: statePda,
        treasury: treasuryPda,
        pool,
        poolDeposit: poolDepositB,
        poolVault,
        depositorUsdcAta: depositorBAta.address,
        treasuryUsdcAccount: treasuryUsdcAta,
        frontendOperator: null,
        frontendUsdcAta: null,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([depositorB])
      .rpc();

    const depositA = await program.account.poolDeposit.fetch(poolDepositA);
    const depositB = await program.account.poolDeposit.fetch(poolDepositB);
    assert.isTrue(depositA.totalYieldClaimed.gt(new anchor.BN(0)));
    assert.isTrue(depositB.totalYieldClaimed.gt(new anchor.BN(0)));
    assert.isTrue(
      depositB.totalYieldClaimed.gte(depositA.totalYieldClaimed),
      "larger depositor should not claim less yield",
    );
  });

  it("updates depositor yield preference with signer and value validation", async () => {
    const operator = Keypair.generate();
    await airdropSol(connection, operator, 0.05);
    const operatorAuth = await authorizeOperator(operator);
    const { pool, poolVault } = await createPoolForOperator({
      operator,
      operatorAuth,
      rateBps: 1_200,
      capacity: 0n,
      minimumDeposit: 10_000n,
      poolName: "preference-pool",
    });

    const depositor = Keypair.generate();
    const attacker = Keypair.generate();
    await Promise.all([
      airdropSol(connection, depositor, 0.05),
      airdropSol(connection, attacker, 0.05),
    ]);

    const depositorAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      usdcMint,
      depositor.publicKey,
    );
    await mintTo(
      connection,
      payer,
      usdcMint,
      depositorAta.address,
      provider.wallet.publicKey,
      1_000_000n,
    );

    const poolDeposit = derivePoolDeposit(pool, depositor.publicKey);
    await program.methods
      .depositToPool(toBn(500_000n))
      .accountsPartial({
        depositor: depositor.publicKey,
        pool,
        state: statePda,
        treasury: treasuryPda,
        poolDeposit,
        poolVault,
        depositorUsdcAta: depositorAta.address,
        treasuryUsdcAccount: treasuryUsdcAta,
        frontendOperator: null,
        frontendUsdcAta: null,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([depositor])
      .rpc();

    let depositAccount = await program.account.poolDeposit.fetch(poolDeposit);
    assert.equal(depositAccount.yieldPreference, 0);
    assert.equal(depositAccount.totalYieldCompounded.toString(), "0");

    await program.methods
      .setYieldPreference(1)
      .accountsPartial({
        depositor: depositor.publicKey,
        pool,
        poolDeposit,
      })
      .signers([depositor])
      .rpc();

    depositAccount = await program.account.poolDeposit.fetch(poolDeposit);
    assert.equal(depositAccount.yieldPreference, 1);

    await program.methods
      .setYieldPreference(1)
      .accountsPartial({
        depositor: depositor.publicKey,
        pool,
        poolDeposit,
      })
      .signers([depositor])
      .rpc();
    depositAccount = await program.account.poolDeposit.fetch(poolDeposit);
    assert.equal(depositAccount.yieldPreference, 1);

    await program.methods
      .setYieldPreference(0)
      .accountsPartial({
        depositor: depositor.publicKey,
        pool,
        poolDeposit,
      })
      .signers([depositor])
      .rpc();
    depositAccount = await program.account.poolDeposit.fetch(poolDeposit);
    assert.equal(depositAccount.yieldPreference, 0);

    await expectTxFailure(
      program.methods
        .setYieldPreference(2)
        .accountsPartial({
          depositor: depositor.publicKey,
          pool,
          poolDeposit,
        })
        .signers([depositor])
        .rpc(),
      "InvalidYieldPreference",
    );

    await expectTxFailure(
      program.methods
        .setYieldPreference(1)
        .accountsPartial({
          depositor: attacker.publicKey,
          pool,
          poolDeposit,
        })
        .signers([attacker])
        .rpc(),
      "ConstraintSeeds",
    );
  });

  it("compounds pool yield for a depositor and updates accounting invariants", async function () {
    await program.methods
      .updateFeeRates(0, 1, null, null, null)
      .accountsPartial({
        state: statePda,
        authority: provider.wallet.publicKey,
      })
      .rpc();

    try {
      const operator = Keypair.generate();
      const depositor = Keypair.generate();
      await Promise.all([airdropSol(connection, operator, 0.05), airdropSol(connection, depositor, 0.05)]);
      const operatorAuth = await authorizeOperator(operator);
      const { pool, poolVault } = await createPoolForOperator({
        operator,
        operatorAuth,
        rateBps: 10_000,
        capacity: 0n,
        minimumDeposit: 10_000n,
        poolName: "compound-depositor",
      });

      const depositorAta = await getOrCreateAssociatedTokenAccount(
        connection,
        payer,
        usdcMint,
        depositor.publicKey,
      );
      const depositAmount = 2_000_000_000_000n;
      await mintTo(
        connection,
        payer,
        usdcMint,
        depositorAta.address,
        provider.wallet.publicKey,
        depositAmount + 300_000_000_000n,
      );

      const poolDeposit = derivePoolDeposit(pool, depositor.publicKey);
      await program.methods
        .depositToPool(toBn(depositAmount))
        .accountsPartial({
          depositor: depositor.publicKey,
          pool,
          state: statePda,
          treasury: treasuryPda,
          poolDeposit,
          poolVault,
          depositorUsdcAta: depositorAta.address,
          treasuryUsdcAccount: treasuryUsdcAta,
          frontendOperator: null,
          frontendUsdcAta: null,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([depositor])
        .rpc();

      await new Promise((resolve) => setTimeout(resolve, 2_500));

      const treasuryBefore = (await getAccount(connection, treasuryUsdcAta)).amount;
      const poolBefore = await program.account.poolState.fetch(pool);
      const depositBefore = await program.account.poolDeposit.fetch(poolDeposit);
      const availableBefore =
        bnToBigInt(poolBefore.currentTotalDeposits) - bnToBigInt(poolBefore.currentUtilized);

      await program.methods
        .compoundPoolYield()
        .accountsPartial({
          caller: depositor.publicKey,
          state: statePda,
          treasury: treasuryPda,
          pool,
          poolDeposit,
          depositor: depositor.publicKey,
          poolVault,
          treasuryUsdcAccount: treasuryUsdcAta,
          frontendUsdcAta: null,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([depositor])
        .rpc();

      const treasuryAfter = (await getAccount(connection, treasuryUsdcAta)).amount;
      const poolAfter = await program.account.poolState.fetch(pool);
      const depositAfter = await program.account.poolDeposit.fetch(poolDeposit);
      const availableAfter =
        bnToBigInt(poolAfter.currentTotalDeposits) - bnToBigInt(poolAfter.currentUtilized);

      const netCompounded = bnToBigInt(depositAfter.depositAmount) - bnToBigInt(depositBefore.depositAmount);
      const feeCollected = treasuryAfter - treasuryBefore;
      const grossYield = netCompounded + feeCollected;
      const pendingYieldBefore = bnToBigInt(poolBefore.totalPendingYield);
      const pendingYieldAfter = bnToBigInt(poolAfter.totalPendingYield);

      assert.isTrue(netCompounded > 0n, "net compounded amount should be positive");
      assert.isTrue(feeCollected > 0n, "treasury should receive protocol fee from compound");
      assert.equal(feeCollected.toString(), (grossYield / 100_000n).toString());
      assert.equal(
        bnToBigInt(depositAfter.totalYieldCompounded).toString(),
        (bnToBigInt(depositBefore.totalYieldCompounded) + netCompounded).toString(),
      );
      assert.equal(depositAfter.accruedYield.toString(), "0");
      assert.equal(
        (bnToBigInt(poolAfter.currentTotalDeposits) - bnToBigInt(poolBefore.currentTotalDeposits)).toString(),
        netCompounded.toString(),
      );
      assert.equal(
        (bnToBigInt(poolAfter.totalYieldDistributed) - bnToBigInt(poolBefore.totalYieldDistributed)).toString(),
        netCompounded.toString(),
      );
      assert.equal(
        pendingYieldAfter.toString(),
        pendingYieldBefore.toString(),
        "compound should not leave residual pending yield",
      );
      assert.equal((availableAfter - availableBefore).toString(), netCompounded.toString());
    } finally {
      await program.methods
        .updateFeeRates(0, 0, null, null, null)
        .accountsPartial({
          state: statePda,
          authority: provider.wallet.publicKey,
        })
        .rpc();
    }
  });

  it("enforces bot preference checks and preserves depositor fallback compound", async function () {
    await program.methods
      .updateFeeRates(0, 1, null, null, null)
      .accountsPartial({
        state: statePda,
        authority: provider.wallet.publicKey,
      })
      .rpc();

    try {
      const operator = Keypair.generate();
      const depositor = Keypair.generate();
      await Promise.all([airdropSol(connection, operator, 0.05), airdropSol(connection, depositor, 0.05)]);

      const operatorAuth = await authorizeOperator(operator);
      const { pool, poolVault } = await createPoolForOperator({
        operator,
        operatorAuth,
        rateBps: 10_000,
        capacity: 0n,
        minimumDeposit: 10_000n,
        poolName: "compound-bot-check",
      });

      const depositorAta = await getOrCreateAssociatedTokenAccount(
        connection,
        payer,
        usdcMint,
        depositor.publicKey,
      );
      const depositAmount = 1_500_000_000_000n;
      await mintTo(
        connection,
        payer,
        usdcMint,
        depositorAta.address,
        provider.wallet.publicKey,
        depositAmount + 200_000_000_000n,
      );
      const poolDeposit = derivePoolDeposit(pool, depositor.publicKey);
      await program.methods
        .depositToPool(toBn(depositAmount))
        .accountsPartial({
          depositor: depositor.publicKey,
          pool,
          state: statePda,
          treasury: treasuryPda,
          poolDeposit,
          poolVault,
          depositorUsdcAta: depositorAta.address,
          treasuryUsdcAccount: treasuryUsdcAta,
          frontendOperator: null,
          frontendUsdcAta: null,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([depositor])
        .rpc();

      await program.methods
        .setYieldPreference(1)
        .accountsPartial({
          depositor: depositor.publicKey,
          pool,
          poolDeposit,
        })
        .signers([depositor])
        .rpc();

      await new Promise((resolve) => setTimeout(resolve, 2_500));

      await expectTxFailure(
        program.methods
          .compoundPoolYield()
          .accountsPartial({
            caller: provider.wallet.publicKey,
            state: statePda,
            treasury: treasuryPda,
            pool,
            poolDeposit,
            depositor: depositor.publicKey,
            poolVault,
            treasuryUsdcAccount: treasuryUsdcAta,
            frontendUsdcAta: null,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .rpc(),
        "YieldPreferenceMismatch",
      );

      const treasuryBeforeFallback = (await getAccount(connection, treasuryUsdcAta)).amount;
      await program.methods
        .compoundPoolYield()
        .accountsPartial({
          caller: depositor.publicKey,
          state: statePda,
          treasury: treasuryPda,
          pool,
          poolDeposit,
          depositor: depositor.publicKey,
          poolVault,
          treasuryUsdcAccount: treasuryUsdcAta,
          frontendUsdcAta: null,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([depositor])
        .rpc();
      const treasuryAfterFallback = (await getAccount(connection, treasuryUsdcAta)).amount;
      const afterDepositorFallback = await program.account.poolDeposit.fetch(poolDeposit);
      assert.isTrue(
        treasuryAfterFallback - treasuryBeforeFallback > 0n,
        "manual depositor compound should still charge fee and succeed",
      );
      assert.equal(afterDepositorFallback.yieldPreference, 1);

      await program.methods
        .setYieldPreference(0)
        .accountsPartial({
          depositor: depositor.publicKey,
          pool,
          poolDeposit,
        })
        .signers([depositor])
        .rpc();

      await new Promise((resolve) => setTimeout(resolve, 2_500));

      const treasuryBeforeBotCompound = (await getAccount(connection, treasuryUsdcAta)).amount;
      await program.methods
        .compoundPoolYield()
        .accountsPartial({
          caller: provider.wallet.publicKey,
          state: statePda,
          treasury: treasuryPda,
          pool,
          poolDeposit,
          depositor: depositor.publicKey,
          poolVault,
          treasuryUsdcAccount: treasuryUsdcAta,
          frontendUsdcAta: null,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
      const treasuryAfterBotCompound = (await getAccount(connection, treasuryUsdcAta)).amount;
      const afterBotCompound = await program.account.poolDeposit.fetch(poolDeposit);
      assert.isTrue(
        treasuryAfterBotCompound - treasuryBeforeBotCompound > 0n,
        "authorized bot should be able to compound when preference is COMPOUND",
      );
      assert.isTrue(
        bnToBigInt(afterBotCompound.totalYieldCompounded) >
          bnToBigInt(afterDepositorFallback.totalYieldCompounded),
      );
    } finally {
      await program.methods
        .updateFeeRates(0, 0, null, null, null)
        .accountsPartial({
          state: statePda,
          authority: provider.wallet.publicKey,
        })
        .rpc();
    }
  });

  it("rejects zero-yield and unauthorized callers for compound_pool_yield", async function () {
    const operator = Keypair.generate();
    const depositor = Keypair.generate();
    const attacker = Keypair.generate();
    await Promise.all([
      airdropSol(connection, operator, 0.05),
      airdropSol(connection, depositor, 0.05),
      airdropSol(connection, attacker, 0.05),
    ]);

    const operatorAuth = await authorizeOperator(operator);
    const { pool, poolVault } = await createPoolForOperator({
      operator,
      operatorAuth,
      rateBps: 1_000,
      capacity: 0n,
      minimumDeposit: 10_000n,
      poolName: "compound-failure-checks",
    });

    const depositorAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      usdcMint,
      depositor.publicKey,
    );
    const tinyDepositAmount = 10_000n;
    await mintTo(
      connection,
      payer,
      usdcMint,
      depositorAta.address,
      provider.wallet.publicKey,
      tinyDepositAmount + 500_000n,
    );
    const poolDeposit = derivePoolDeposit(pool, depositor.publicKey);
    await program.methods
      .depositToPool(toBn(tinyDepositAmount))
      .accountsPartial({
        depositor: depositor.publicKey,
        pool,
        state: statePda,
        treasury: treasuryPda,
        poolDeposit,
        poolVault,
        depositorUsdcAta: depositorAta.address,
        treasuryUsdcAccount: treasuryUsdcAta,
        frontendOperator: null,
        frontendUsdcAta: null,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([depositor])
      .rpc();

    await expectTxFailure(
      program.methods
        .compoundPoolYield()
        .accountsPartial({
          caller: depositor.publicKey,
          state: statePda,
          treasury: treasuryPda,
          pool,
          poolDeposit,
          depositor: depositor.publicKey,
          poolVault,
          treasuryUsdcAccount: treasuryUsdcAta,
          frontendUsdcAta: null,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([depositor])
        .rpc(),
      "NoPaymentDue",
    );

    await expectTxFailure(
      program.methods
        .compoundPoolYield()
        .accountsPartial({
          caller: attacker.publicKey,
          state: statePda,
          treasury: treasuryPda,
          pool,
          poolDeposit,
          depositor: depositor.publicKey,
          poolVault,
          treasuryUsdcAccount: treasuryUsdcAta,
          frontendUsdcAta: null,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([attacker])
        .rpc(),
      "UnauthorizedBotOperation",
    );
  });

  it("splits frontend fees during compound and accrues yield on compounded principal", async function () {
    assert.isTrue(
      hasRegisterFrontendInstruction,
      "register_frontend instruction must be available for frontend fee split coverage",
    );

    await program.methods
      .updateFeeRates(0, 1, null, null, null)
      .accountsPartial({
        state: statePda,
        authority: provider.wallet.publicKey,
      })
      .rpc();

    try {
      const operator = Keypair.generate();
      const frontend = Keypair.generate();
      const depositor = Keypair.generate();
      await Promise.all([
        airdropSol(connection, operator, 0.05),
        airdropSol(connection, frontend, 0.02),
        airdropSol(connection, depositor, 0.05),
      ]);

      const operatorAuth = await authorizeOperator(operator);
      const frontendOperator = await registerFrontend(frontend);
      const frontendAta = await getOrCreateAssociatedTokenAccount(
        connection,
        payer,
        usdcMint,
        frontend.publicKey,
      );
      const { pool, poolVault } = await createPoolForOperator({
        operator,
        operatorAuth,
        rateBps: 10_000,
        capacity: 0n,
        minimumDeposit: 10_000n,
        poolName: "compound-frontend",
      });

      const depositorAta = await getOrCreateAssociatedTokenAccount(
        connection,
        payer,
        usdcMint,
        depositor.publicKey,
      );
      const depositAmount = 2_000_000_000_000n;
      await mintTo(
        connection,
        payer,
        usdcMint,
        depositorAta.address,
        provider.wallet.publicKey,
        depositAmount + 300_000_000_000n,
      );

      const poolDeposit = derivePoolDeposit(pool, depositor.publicKey);
      await program.methods
        .depositToPool(toBn(depositAmount))
        .accountsPartial({
          depositor: depositor.publicKey,
          pool,
          state: statePda,
          treasury: treasuryPda,
          poolDeposit,
          poolVault,
          depositorUsdcAta: depositorAta.address,
          treasuryUsdcAccount: treasuryUsdcAta,
          frontendOperator,
          frontendUsdcAta: frontendAta.address,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([depositor])
        .rpc();

      await new Promise((resolve) => setTimeout(resolve, 2_500));

      const treasuryBeforeFirstCompound = (await getAccount(connection, treasuryUsdcAta)).amount;
      const frontendBeforeFirstCompound = (await getAccount(connection, frontendAta.address)).amount;
      await program.methods
        .compoundPoolYield()
        .accountsPartial({
          caller: depositor.publicKey,
          state: statePda,
          treasury: treasuryPda,
          pool,
          poolDeposit,
          depositor: depositor.publicKey,
          poolVault,
          treasuryUsdcAccount: treasuryUsdcAta,
          frontendUsdcAta: frontendAta.address,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([depositor])
        .rpc();
      const treasuryAfterFirstCompound = (await getAccount(connection, treasuryUsdcAta)).amount;
      const frontendAfterFirstCompound = (await getAccount(connection, frontendAta.address)).amount;
      const firstDepositState = await program.account.poolDeposit.fetch(poolDeposit);

      const treasuryFeeDelta = treasuryAfterFirstCompound - treasuryBeforeFirstCompound;
      const frontendFeeDelta = frontendAfterFirstCompound - frontendBeforeFirstCompound;
      const totalYieldFee = treasuryFeeDelta + frontendFeeDelta;
      assert.isTrue(totalYieldFee > 0n, "compound should collect yield fees");
      assert.isTrue(treasuryFeeDelta > 0n, "treasury should receive a fee share");
      assert.equal(frontendFeeDelta.toString(), ((totalYieldFee * 8n) / 10n).toString());

      await new Promise((resolve) => setTimeout(resolve, 2_500));

      await program.methods
        .compoundPoolYield()
        .accountsPartial({
          caller: depositor.publicKey,
          state: statePda,
          treasury: treasuryPda,
          pool,
          poolDeposit,
          depositor: depositor.publicKey,
          poolVault,
          treasuryUsdcAccount: treasuryUsdcAta,
          frontendUsdcAta: frontendAta.address,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([depositor])
        .rpc();
      const secondDepositState = await program.account.poolDeposit.fetch(poolDeposit);

      assert.isTrue(
        bnToBigInt(secondDepositState.totalYieldCompounded) >
          bnToBigInt(firstDepositState.totalYieldCompounded),
        "second compound should add additional compounded yield",
      );
      assert.isTrue(
        bnToBigInt(secondDepositState.depositAmount) > bnToBigInt(firstDepositState.depositAmount),
        "yield should continue accruing on the already-compounded principal",
      );
    } finally {
      await program.methods
        .updateFeeRates(0, 0, null, null, null)
        .accountsPartial({
          state: statePda,
          authority: provider.wallet.publicKey,
        })
        .rpc();
    }
  });

  it("bot auto-claims for CLAIM preference and preserves manual claim fallback", async function () {
    await program.methods
      .updateFeeRates(0, 1, null, null, null)
      .accountsPartial({
        state: statePda,
        authority: provider.wallet.publicKey,
      })
      .rpc();

    try {
      const operator = Keypair.generate();
      const depositor = Keypair.generate();
      await Promise.all([airdropSol(connection, operator, 0.05), airdropSol(connection, depositor, 0.05)]);
      const operatorAuth = await authorizeOperator(operator);
      const { pool, poolVault } = await createPoolForOperator({
        operator,
        operatorAuth,
        rateBps: 10_000,
        capacity: 0n,
        minimumDeposit: 10_000n,
        poolName: "bot-claim-fallback",
      });

      const depositorAta = await getOrCreateAssociatedTokenAccount(
        connection,
        payer,
        usdcMint,
        depositor.publicKey,
      );
      const depositAmount = 2_000_000_000_000n;
      await mintTo(
        connection,
        payer,
        usdcMint,
        depositorAta.address,
        provider.wallet.publicKey,
        depositAmount + 300_000_000_000n,
      );

      const poolDeposit = derivePoolDeposit(pool, depositor.publicKey);
      await program.methods
        .depositToPool(toBn(depositAmount))
        .accountsPartial({
          depositor: depositor.publicKey,
          pool,
          state: statePda,
          treasury: treasuryPda,
          poolDeposit,
          poolVault,
          depositorUsdcAta: depositorAta.address,
          treasuryUsdcAccount: treasuryUsdcAta,
          frontendOperator: null,
          frontendUsdcAta: null,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([depositor])
        .rpc();

      await program.methods
        .setYieldPreference(1)
        .accountsPartial({
          depositor: depositor.publicKey,
          pool,
          poolDeposit,
        })
        .signers([depositor])
        .rpc();

      await new Promise((resolve) => setTimeout(resolve, 2_500));

      const treasuryBeforeBotClaim = (await getAccount(connection, treasuryUsdcAta)).amount;
      const depositorBeforeBotClaim = (await getAccount(connection, depositorAta.address)).amount;
      const depositStateBeforeBotClaim = await program.account.poolDeposit.fetch(poolDeposit);
      await program.methods
        .botClaimPoolYield()
        .accountsPartial({
          botAuthority: provider.wallet.publicKey,
          state: statePda,
          treasury: treasuryPda,
          pool,
          poolDeposit,
          depositor: depositor.publicKey,
          poolVault,
          depositorUsdcAta: depositorAta.address,
          treasuryUsdcAccount: treasuryUsdcAta,
          frontendUsdcAta: null,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
      const treasuryAfterBotClaim = (await getAccount(connection, treasuryUsdcAta)).amount;
      const depositorAfterBotClaim = (await getAccount(connection, depositorAta.address)).amount;
      const depositStateAfterBotClaim = await program.account.poolDeposit.fetch(poolDeposit);
      const firstNetClaim = depositorAfterBotClaim - depositorBeforeBotClaim;
      const firstFeeClaim = treasuryAfterBotClaim - treasuryBeforeBotClaim;
      assert.isTrue(firstNetClaim > 0n, "bot claim should transfer net yield to depositor");
      assert.isTrue(firstFeeClaim > 0n, "bot claim should transfer protocol fee to treasury");
      assert.equal(
        bnToBigInt(depositStateAfterBotClaim.totalYieldClaimed).toString(),
        (bnToBigInt(depositStateBeforeBotClaim.totalYieldClaimed) + firstNetClaim).toString(),
      );

      await new Promise((resolve) => setTimeout(resolve, 2_500));

      const depositorBeforeManualClaim = (await getAccount(connection, depositorAta.address)).amount;
      await program.methods
        .claimPoolYield()
        .accountsPartial({
          depositor: depositor.publicKey,
          state: statePda,
          treasury: treasuryPda,
          pool,
          poolDeposit,
          poolVault,
          depositorUsdcAta: depositorAta.address,
          treasuryUsdcAccount: treasuryUsdcAta,
          frontendUsdcAta: null,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([depositor])
        .rpc();
      const depositorAfterManualClaim = (await getAccount(connection, depositorAta.address)).amount;
      const finalDepositState = await program.account.poolDeposit.fetch(poolDeposit);
      assert.isTrue(
        depositorAfterManualClaim > depositorBeforeManualClaim,
        "manual claim should remain available even when preference is CLAIM",
      );
      assert.equal(finalDepositState.yieldPreference, 1, "manual fallback should not alter preference");
    } finally {
      await program.methods
        .updateFeeRates(0, 0, null, null, null)
        .accountsPartial({
          state: statePda,
          authority: provider.wallet.publicKey,
        })
        .rpc();
    }
  });

  it("rejects bot claim for compound preference, unauthorized signers, and zero yield", async function () {
    const operator = Keypair.generate();
    const depositor = Keypair.generate();
    const attacker = Keypair.generate();
    await Promise.all([
      airdropSol(connection, operator, 0.05),
      airdropSol(connection, depositor, 0.05),
      airdropSol(connection, attacker, 0.05),
    ]);
    const operatorAuth = await authorizeOperator(operator);
    const { pool, poolVault } = await createPoolForOperator({
      operator,
      operatorAuth,
      rateBps: 0,
      capacity: 0n,
      minimumDeposit: 10_000n,
      poolName: "bot-claim-failures",
    });

    const depositorAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      usdcMint,
      depositor.publicKey,
    );
    const depositAmount = 1_000_000_000_000n;
    await mintTo(
      connection,
      payer,
      usdcMint,
      depositorAta.address,
      provider.wallet.publicKey,
      depositAmount + 200_000_000_000n,
    );

    const poolDeposit = derivePoolDeposit(pool, depositor.publicKey);
    await program.methods
      .depositToPool(toBn(depositAmount))
      .accountsPartial({
        depositor: depositor.publicKey,
        pool,
        state: statePda,
        treasury: treasuryPda,
        poolDeposit,
        poolVault,
        depositorUsdcAta: depositorAta.address,
        treasuryUsdcAccount: treasuryUsdcAta,
        frontendOperator: null,
        frontendUsdcAta: null,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([depositor])
      .rpc();

    await program.methods
      .setYieldPreference(1)
      .accountsPartial({
        depositor: depositor.publicKey,
        pool,
        poolDeposit,
      })
      .signers([depositor])
      .rpc();

    await expectTxFailure(
      program.methods
        .botClaimPoolYield()
        .accountsPartial({
          botAuthority: provider.wallet.publicKey,
          state: statePda,
          treasury: treasuryPda,
          pool,
          poolDeposit,
          depositor: depositor.publicKey,
          poolVault,
          depositorUsdcAta: depositorAta.address,
          treasuryUsdcAccount: treasuryUsdcAta,
          frontendUsdcAta: null,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc(),
      "NoPaymentDue",
    );

    await new Promise((resolve) => setTimeout(resolve, 2_500));

    await expectTxFailure(
      program.methods
        .botClaimPoolYield()
        .accountsPartial({
          botAuthority: attacker.publicKey,
          state: statePda,
          treasury: treasuryPda,
          pool,
          poolDeposit,
          depositor: depositor.publicKey,
          poolVault,
          depositorUsdcAta: depositorAta.address,
          treasuryUsdcAccount: treasuryUsdcAta,
          frontendUsdcAta: null,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([attacker])
        .rpc(),
      "UnauthorizedBotOperation",
    );

    await program.methods
      .setYieldPreference(0)
      .accountsPartial({
        depositor: depositor.publicKey,
        pool,
        poolDeposit,
      })
      .signers([depositor])
      .rpc();

    await expectTxFailure(
      program.methods
        .botClaimPoolYield()
        .accountsPartial({
          botAuthority: provider.wallet.publicKey,
          state: statePda,
          treasury: treasuryPda,
          pool,
          poolDeposit,
          depositor: depositor.publicKey,
          poolVault,
          depositorUsdcAta: depositorAta.address,
          treasuryUsdcAccount: treasuryUsdcAta,
          frontendUsdcAta: null,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc(),
      "YieldPreferenceMismatch",
    );
  });

  it("splits frontend fees during bot claim and tracks total_yield_claimed", async function () {
    await program.methods
      .updateFeeRates(0, 1, null, null, null)
      .accountsPartial({
        state: statePda,
        authority: provider.wallet.publicKey,
      })
      .rpc();

    try {
      const operator = Keypair.generate();
      const frontend = Keypair.generate();
      const depositor = Keypair.generate();
      await Promise.all([
        airdropSol(connection, operator, 0.05),
        airdropSol(connection, frontend, 0.02),
        airdropSol(connection, depositor, 0.05),
      ]);

      const operatorAuth = await authorizeOperator(operator);
      const frontendOperator = await registerFrontend(frontend);
      const frontendAta = await getOrCreateAssociatedTokenAccount(
        connection,
        payer,
        usdcMint,
        frontend.publicKey,
      );
      const { pool, poolVault } = await createPoolForOperator({
        operator,
        operatorAuth,
        rateBps: 10_000,
        capacity: 0n,
        minimumDeposit: 10_000n,
        poolName: "bot-claim-frontend",
      });

      const depositorAta = await getOrCreateAssociatedTokenAccount(
        connection,
        payer,
        usdcMint,
        depositor.publicKey,
      );
      const depositAmount = 2_000_000_000_000n;
      await mintTo(
        connection,
        payer,
        usdcMint,
        depositorAta.address,
        provider.wallet.publicKey,
        depositAmount + 300_000_000_000n,
      );

      const poolDeposit = derivePoolDeposit(pool, depositor.publicKey);
      await program.methods
        .depositToPool(toBn(depositAmount))
        .accountsPartial({
          depositor: depositor.publicKey,
          pool,
          state: statePda,
          treasury: treasuryPda,
          poolDeposit,
          poolVault,
          depositorUsdcAta: depositorAta.address,
          treasuryUsdcAccount: treasuryUsdcAta,
          frontendOperator,
          frontendUsdcAta: frontendAta.address,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([depositor])
        .rpc();

      await program.methods
        .setYieldPreference(1)
        .accountsPartial({
          depositor: depositor.publicKey,
          pool,
          poolDeposit,
        })
        .signers([depositor])
        .rpc();

      await new Promise((resolve) => setTimeout(resolve, 2_500));

      const treasuryBeforeClaim = (await getAccount(connection, treasuryUsdcAta)).amount;
      const frontendBeforeClaim = (await getAccount(connection, frontendAta.address)).amount;
      const depositorBeforeClaim = (await getAccount(connection, depositorAta.address)).amount;
      const depositBeforeClaim = await program.account.poolDeposit.fetch(poolDeposit);
      await program.methods
        .botClaimPoolYield()
        .accountsPartial({
          botAuthority: provider.wallet.publicKey,
          state: statePda,
          treasury: treasuryPda,
          pool,
          poolDeposit,
          depositor: depositor.publicKey,
          poolVault,
          depositorUsdcAta: depositorAta.address,
          treasuryUsdcAccount: treasuryUsdcAta,
          frontendUsdcAta: frontendAta.address,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
      const treasuryAfterClaim = (await getAccount(connection, treasuryUsdcAta)).amount;
      const frontendAfterClaim = (await getAccount(connection, frontendAta.address)).amount;
      const depositorAfterClaim = (await getAccount(connection, depositorAta.address)).amount;
      const depositAfterClaim = await program.account.poolDeposit.fetch(poolDeposit);

      const treasuryFeeDelta = treasuryAfterClaim - treasuryBeforeClaim;
      const frontendFeeDelta = frontendAfterClaim - frontendBeforeClaim;
      const totalYieldFee = treasuryFeeDelta + frontendFeeDelta;
      const netClaimed = depositorAfterClaim - depositorBeforeClaim;
      assert.isTrue(totalYieldFee > 0n, "bot claim should collect yield fees");
      assert.isTrue(treasuryFeeDelta > 0n, "treasury should receive a fee share");
      assert.equal(frontendFeeDelta.toString(), ((totalYieldFee * 8n) / 10n).toString());
      assert.equal(
        bnToBigInt(depositAfterClaim.totalYieldClaimed).toString(),
        (bnToBigInt(depositBeforeClaim.totalYieldClaimed) + netClaimed).toString(),
      );
    } finally {
      await program.methods
        .updateFeeRates(0, 0, null, null, null)
        .accountsPartial({
          state: statePda,
          authority: provider.wallet.publicKey,
        })
        .rpc();
    }
  });

  it("applies pool deposit/yield fees and skips treasury transfers when fees are zero", async () => {
    await program.methods
      .updateFeeRates(1, 1, null, null, null)
      .accountsPartial({
        state: statePda,
        authority: provider.wallet.publicKey,
      })
      .rpc();

    const operator = Keypair.generate();
    await airdropSol(connection, operator, 0.05);
    const operatorAuth = await authorizeOperator(operator);
    const { pool, poolVault } = await createPoolForOperator({
      operator,
      operatorAuth,
      rateBps: 10_000,
      capacity: 0n,
      minimumDeposit: 10_000n,
      poolName: "pool-fee-check",
    });

    const depositor = Keypair.generate();
    await airdropSol(connection, depositor, 0.05);
    const depositorAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      usdcMint,
      depositor.publicKey,
    );
    const depositAmount = 2_000_000_000_000n;
    await mintTo(
      connection,
      payer,
      usdcMint,
      depositorAta.address,
      provider.wallet.publicKey,
      depositAmount + 100_000_000_000n,
    );
    const poolDeposit = derivePoolDeposit(pool, depositor.publicKey);

    const treasuryBeforeDeposit = (await getAccount(connection, treasuryUsdcAta)).amount;
    await program.methods
      .depositToPool(toBn(depositAmount))
      .accountsPartial({
        depositor: depositor.publicKey,
        pool,
        state: statePda,
        treasury: treasuryPda,
        poolDeposit,
        poolVault,
        depositorUsdcAta: depositorAta.address,
        treasuryUsdcAccount: treasuryUsdcAta,
        frontendOperator: null,
        frontendUsdcAta: null,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([depositor])
      .rpc();

    const expectedDepositFee = depositAmount / 100_000n;
    const expectedNetDeposit = depositAmount - expectedDepositFee;
    const treasuryAfterDeposit = (await getAccount(connection, treasuryUsdcAta)).amount;
    const depositAccount = await program.account.poolDeposit.fetch(poolDeposit);
    const poolAccount = await program.account.poolState.fetch(pool);
    assert.equal((treasuryAfterDeposit - treasuryBeforeDeposit).toString(), expectedDepositFee.toString());
    assert.equal(depositAccount.depositAmount.toString(), expectedNetDeposit.toString());
    assert.equal(poolAccount.currentTotalDeposits.toString(), expectedNetDeposit.toString());

    await new Promise((resolve) => setTimeout(resolve, 2_500));

    const treasuryBeforeClaim = (await getAccount(connection, treasuryUsdcAta)).amount;
    const depositorBeforeClaim = (await getAccount(connection, depositorAta.address)).amount;
    await program.methods
      .claimPoolYield()
      .accountsPartial({
        depositor: depositor.publicKey,
        state: statePda,
        treasury: treasuryPda,
        pool,
        poolDeposit,
        poolVault,
        depositorUsdcAta: depositorAta.address,
        treasuryUsdcAccount: treasuryUsdcAta,
        frontendOperator: null,
        frontendUsdcAta: null,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([depositor])
      .rpc();
    const treasuryAfterClaim = (await getAccount(connection, treasuryUsdcAta)).amount;
    const depositorAfterClaim = (await getAccount(connection, depositorAta.address)).amount;
    const claimedNet = depositorAfterClaim - depositorBeforeClaim;
    const claimedFee = treasuryAfterClaim - treasuryBeforeClaim;
    assert.isTrue(claimedNet > 0n, "depositor should receive net yield");
    assert.isTrue(claimedFee > 0n, "treasury should receive yield fee");
    const grossYield = claimedNet + claimedFee;
    assert.equal(claimedFee.toString(), (grossYield / 100_000n).toString());

    await program.methods
      .updateFeeRates(0, 0, null, null, null)
      .accountsPartial({
        state: statePda,
        authority: provider.wallet.publicKey,
      })
      .rpc();

    const zeroFeeDepositor = Keypair.generate();
    await airdropSol(connection, zeroFeeDepositor, 0.05);
    const zeroFeeAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      usdcMint,
      zeroFeeDepositor.publicKey,
    );
    const zeroFeeDepositAmount = 2_000_000_000_000n;
    await mintTo(
      connection,
      payer,
      usdcMint,
      zeroFeeAta.address,
      provider.wallet.publicKey,
      zeroFeeDepositAmount + 100_000_000_000n,
    );
    const zeroFeePoolDeposit = derivePoolDeposit(pool, zeroFeeDepositor.publicKey);

    const treasuryBeforeZeroDeposit = (await getAccount(connection, treasuryUsdcAta)).amount;
    await program.methods
      .depositToPool(toBn(zeroFeeDepositAmount))
      .accountsPartial({
        depositor: zeroFeeDepositor.publicKey,
        pool,
        state: statePda,
        treasury: treasuryPda,
        poolDeposit: zeroFeePoolDeposit,
        poolVault,
        depositorUsdcAta: zeroFeeAta.address,
        treasuryUsdcAccount: treasuryUsdcAta,
        frontendOperator: null,
        frontendUsdcAta: null,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([zeroFeeDepositor])
      .rpc();
    const treasuryAfterZeroDeposit = (await getAccount(connection, treasuryUsdcAta)).amount;
    const zeroFeeDepositAccount = await program.account.poolDeposit.fetch(zeroFeePoolDeposit);
    assert.equal(
      (treasuryAfterZeroDeposit - treasuryBeforeZeroDeposit).toString(),
      "0",
      "treasury should not receive deposit fee when rate is zero",
    );
    assert.equal(zeroFeeDepositAccount.depositAmount.toString(), zeroFeeDepositAmount.toString());

    await new Promise((resolve) => setTimeout(resolve, 2_500));
    const treasuryBeforeZeroClaim = (await getAccount(connection, treasuryUsdcAta)).amount;
    const zeroDepBeforeClaim = (await getAccount(connection, zeroFeeAta.address)).amount;
    await program.methods
      .claimPoolYield()
      .accountsPartial({
        depositor: zeroFeeDepositor.publicKey,
        state: statePda,
        treasury: treasuryPda,
        pool,
        poolDeposit: zeroFeePoolDeposit,
        poolVault,
        depositorUsdcAta: zeroFeeAta.address,
        treasuryUsdcAccount: treasuryUsdcAta,
        frontendOperator: null,
        frontendUsdcAta: null,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([zeroFeeDepositor])
      .rpc();
    const treasuryAfterZeroClaim = (await getAccount(connection, treasuryUsdcAta)).amount;
    const zeroDepAfterClaim = (await getAccount(connection, zeroFeeAta.address)).amount;
    assert.equal(
      (treasuryAfterZeroClaim - treasuryBeforeZeroClaim).toString(),
      "0",
      "treasury should not receive yield fee when rate is zero",
    );
    assert.isTrue(zeroDepAfterClaim > zeroDepBeforeClaim, "depositor should still receive yield");

    // Restore to zero fees (matching the suite-level before() hook).
    await program.methods
      .updateFeeRates(0, 0, null, null, null)
      .accountsPartial({
        state: statePda,
        authority: provider.wallet.publicKey,
      })
      .rpc();
  });

  it("routes pool fee shares to frontends and falls back when frontend accounts are omitted", async function () {
    if (!hasRegisterFrontendInstruction) {
      this.skip();
    }

    await program.methods
      .updateFeeRates(1, 1, null, null, null)
      .accountsPartial({
        state: statePda,
        authority: provider.wallet.publicKey,
      })
      .rpc();

    const operator = Keypair.generate();
    await airdropSol(connection, operator, 0.05);
    const operatorAuth = await authorizeOperator(operator);
    const { pool, poolVault } = await createPoolForOperator({
      operator,
      operatorAuth,
      rateBps: 10_000,
      capacity: 0n,
      minimumDeposit: 10_000n,
      poolName: "frontend-fee-pool",
    });

    const frontendA = Keypair.generate();
    const frontendB = Keypair.generate();
    await Promise.all([
      airdropSol(connection, frontendA, 0.02),
      airdropSol(connection, frontendB, 0.02),
    ]);
    const frontendOperatorA = await registerFrontend(frontendA);
    const frontendOperatorB = await registerFrontend(frontendB);
    const frontendAAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      usdcMint,
      frontendA.publicKey,
    );
    const frontendBAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      usdcMint,
      frontendB.publicKey,
    );

    const depositorOne = Keypair.generate();
    await airdropSol(connection, depositorOne, 0.05);
    const depositorOneAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      usdcMint,
      depositorOne.publicKey,
    );
    const depositOne = 2_000_000_000_000n;
    const depositTwo = 1_000_000_000_000n;
    await mintTo(
      connection,
      payer,
      usdcMint,
      depositorOneAta.address,
      provider.wallet.publicKey,
      depositOne + depositTwo + 300_000_000_000n,
    );
    const poolDepositOne = derivePoolDeposit(pool, depositorOne.publicKey);

    const treasuryBeforeDepositOne = await getAccount(connection, treasuryUsdcAta);
    const frontendABeforeDepositOne = await getAccount(connection, frontendAAta.address);
    await program.methods
      .depositToPool(toBn(depositOne))
      .accountsPartial({
        depositor: depositorOne.publicKey,
        pool,
        state: statePda,
        treasury: treasuryPda,
        poolDeposit: poolDepositOne,
        poolVault,
        depositorUsdcAta: depositorOneAta.address,
        treasuryUsdcAccount: treasuryUsdcAta,
        frontendOperator: frontendOperatorA,
        frontendUsdcAta: frontendAAta.address,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([depositorOne])
      .rpc();
    const treasuryAfterDepositOne = await getAccount(connection, treasuryUsdcAta);
    const frontendAAfterDepositOne = await getAccount(connection, frontendAAta.address);
    const expectedDepositFeeOne = depositOne / 100_000n;
    const expectedFrontendShareOne = (expectedDepositFeeOne * 8n) / 10n;
    assert.equal(
      (treasuryAfterDepositOne.amount - treasuryBeforeDepositOne.amount).toString(),
      (expectedDepositFeeOne - expectedFrontendShareOne).toString(),
    );
    assert.equal(
      (frontendAAfterDepositOne.amount - frontendABeforeDepositOne.amount).toString(),
      expectedFrontendShareOne.toString(),
    );

    await new Promise((resolve) => setTimeout(resolve, 2_500));
    const treasuryBeforeYieldOne = await getAccount(connection, treasuryUsdcAta);
    const frontendABeforeYieldOne = await getAccount(connection, frontendAAta.address);
    await program.methods
      .claimPoolYield()
      .accountsPartial({
        depositor: depositorOne.publicKey,
        state: statePda,
        treasury: treasuryPda,
        pool,
        poolDeposit: poolDepositOne,
        poolVault,
        depositorUsdcAta: depositorOneAta.address,
        treasuryUsdcAccount: treasuryUsdcAta,
        frontendUsdcAta: frontendAAta.address,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([depositorOne])
      .rpc();
    const treasuryAfterYieldOne = await getAccount(connection, treasuryUsdcAta);
    const frontendAAfterYieldOne = await getAccount(connection, frontendAAta.address);
    const treasuryYieldDeltaOne = treasuryAfterYieldOne.amount - treasuryBeforeYieldOne.amount;
    const frontendYieldDeltaOne = frontendAAfterYieldOne.amount - frontendABeforeYieldOne.amount;
    const totalYieldFeeOne = treasuryYieldDeltaOne + frontendYieldDeltaOne;
    assert.isTrue(totalYieldFeeOne > 0n, "yield fee should be collected");
    assert.equal(frontendYieldDeltaOne.toString(), ((totalYieldFeeOne * 8n) / 10n).toString());

    const treasuryBeforeDepositTwo = await getAccount(connection, treasuryUsdcAta);
    const frontendBBeforeDepositTwo = await getAccount(connection, frontendBAta.address);
    await program.methods
      .depositToPool(toBn(depositTwo))
      .accountsPartial({
        depositor: depositorOne.publicKey,
        pool,
        state: statePda,
        treasury: treasuryPda,
        poolDeposit: poolDepositOne,
        poolVault,
        depositorUsdcAta: depositorOneAta.address,
        treasuryUsdcAccount: treasuryUsdcAta,
        frontendOperator: frontendOperatorB,
        frontendUsdcAta: frontendBAta.address,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([depositorOne])
      .rpc();
    const treasuryAfterDepositTwo = await getAccount(connection, treasuryUsdcAta);
    const frontendBAfterDepositTwo = await getAccount(connection, frontendBAta.address);
    const expectedDepositFeeTwo = depositTwo / 100_000n;
    const expectedFrontendShareTwo = (expectedDepositFeeTwo * 8n) / 10n;
    assert.equal(
      (treasuryAfterDepositTwo.amount - treasuryBeforeDepositTwo.amount).toString(),
      (expectedDepositFeeTwo - expectedFrontendShareTwo).toString(),
    );
    assert.equal(
      (frontendBAfterDepositTwo.amount - frontendBBeforeDepositTwo.amount).toString(),
      expectedFrontendShareTwo.toString(),
    );

    await new Promise((resolve) => setTimeout(resolve, 2_500));
    const treasuryBeforeYieldTwo = await getAccount(connection, treasuryUsdcAta);
    const frontendBBeforeYieldTwo = await getAccount(connection, frontendBAta.address);
    await program.methods
      .claimPoolYield()
      .accountsPartial({
        depositor: depositorOne.publicKey,
        state: statePda,
        treasury: treasuryPda,
        pool,
        poolDeposit: poolDepositOne,
        poolVault,
        depositorUsdcAta: depositorOneAta.address,
        treasuryUsdcAccount: treasuryUsdcAta,
        frontendUsdcAta: frontendBAta.address,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([depositorOne])
      .rpc();
    const treasuryAfterYieldTwo = await getAccount(connection, treasuryUsdcAta);
    const frontendAAfterYieldTwo = await getAccount(connection, frontendAAta.address);
    const frontendBAfterYieldTwo = await getAccount(connection, frontendBAta.address);
    const treasuryYieldDeltaTwo = treasuryAfterYieldTwo.amount - treasuryBeforeYieldTwo.amount;
    const frontendBYieldDeltaTwo = frontendBAfterYieldTwo.amount - frontendBBeforeYieldTwo.amount;
    assert.isTrue(treasuryYieldDeltaTwo + frontendBYieldDeltaTwo > 0n);
    assert.equal(
      (frontendAAfterYieldTwo.amount - frontendAAfterYieldOne.amount).toString(),
      "0",
      "yield should route to the latest stored frontend",
    );

    const depositorTwo = Keypair.generate();
    await airdropSol(connection, depositorTwo, 0.05);
    const depositorTwoAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      usdcMint,
      depositorTwo.publicKey,
    );
    const depositThree = 2_000_000_000_000n;
    await mintTo(
      connection,
      payer,
      usdcMint,
      depositorTwoAta.address,
      provider.wallet.publicKey,
      depositThree + 300_000_000_000n,
    );
    const poolDepositTwo = derivePoolDeposit(pool, depositorTwo.publicKey);
    const treasuryBeforeDepositThree = await getAccount(connection, treasuryUsdcAta);
    const frontendABeforeDepositThree = await getAccount(connection, frontendAAta.address);
    const frontendBBeforeDepositThree = await getAccount(connection, frontendBAta.address);
    await program.methods
      .depositToPool(toBn(depositThree))
      .accountsPartial({
        depositor: depositorTwo.publicKey,
        pool,
        state: statePda,
        treasury: treasuryPda,
        poolDeposit: poolDepositTwo,
        poolVault,
        depositorUsdcAta: depositorTwoAta.address,
        treasuryUsdcAccount: treasuryUsdcAta,
        frontendOperator: null,
        frontendUsdcAta: null,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([depositorTwo])
      .rpc();
    const treasuryAfterDepositThree = await getAccount(connection, treasuryUsdcAta);
    const frontendAAfterDepositThree = await getAccount(connection, frontendAAta.address);
    const frontendBAfterDepositThree = await getAccount(connection, frontendBAta.address);
    assert.equal(
      (treasuryAfterDepositThree.amount - treasuryBeforeDepositThree.amount).toString(),
      (depositThree / 100_000n).toString(),
    );
    assert.equal(
      (frontendAAfterDepositThree.amount - frontendABeforeDepositThree.amount).toString(),
      "0",
    );
    assert.equal(
      (frontendBAfterDepositThree.amount - frontendBBeforeDepositThree.amount).toString(),
      "0",
    );

    await new Promise((resolve) => setTimeout(resolve, 2_500));
    const treasuryBeforeYieldThree = await getAccount(connection, treasuryUsdcAta);
    const frontendABeforeYieldThree = await getAccount(connection, frontendAAta.address);
    const frontendBBeforeYieldThree = await getAccount(connection, frontendBAta.address);
    await program.methods
      .claimPoolYield()
      .accountsPartial({
        depositor: depositorTwo.publicKey,
        state: statePda,
        treasury: treasuryPda,
        pool,
        poolDeposit: poolDepositTwo,
        poolVault,
        depositorUsdcAta: depositorTwoAta.address,
        treasuryUsdcAccount: treasuryUsdcAta,
        frontendOperator: null,
        frontendUsdcAta: null,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([depositorTwo])
      .rpc();
    const treasuryAfterYieldThree = await getAccount(connection, treasuryUsdcAta);
    const frontendAAfterYieldThree = await getAccount(connection, frontendAAta.address);
    const frontendBAfterYieldThree = await getAccount(connection, frontendBAta.address);
    assert.isTrue(
      treasuryAfterYieldThree.amount - treasuryBeforeYieldThree.amount > 0n,
      "yield fee should fall back to treasury when no frontend is stored",
    );
    assert.equal(
      (frontendAAfterYieldThree.amount - frontendABeforeYieldThree.amount).toString(),
      "0",
    );
    assert.equal(
      (frontendBAfterYieldThree.amount - frontendBBeforeYieldThree.amount).toString(),
      "0",
    );

    await program.methods
      .updateFeeRates(0, 0, null, null, null)
      .accountsPartial({
        state: statePda,
        authority: provider.wallet.publicKey,
      })
      .rpc();
  });

  it("enforces pool deployment rules for loan type, ltv, and term", async () => {
    if (!canRunContractFlows) {
      return;
    }

    const operator = Keypair.generate();
    await airdropSol(connection, operator, 0.05);
    const operatorAuth = await authorizeOperator(operator);

    const depositor = Keypair.generate();
    await airdropSol(connection, depositor, 0.05);
    const depositorAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      usdcMint,
      depositor.publicKey,
    );
    await mintTo(
      connection,
      payer,
      usdcMint,
      depositorAta.address,
      provider.wallet.publicKey,
      250_000_000n,
    );

    const fixture = await createDebtContractFixture(50_000_000n);

    const committedOnlyPool = await createPoolForOperator({
      operator,
      operatorAuth,
      capacity: 0n,
      minimumDeposit: 10_000n,
      allowedLoanType: 2,
      poolName: "rules-committed",
    });
    const committedOnlyDeposit = derivePoolDeposit(committedOnlyPool.pool, depositor.publicKey);
    await program.methods
      .depositToPool(toBn(60_000_000n))
      .accountsPartial({
        depositor: depositor.publicKey,
        pool: committedOnlyPool.pool,
        state: statePda,
        treasury: treasuryPda,
        poolDeposit: committedOnlyDeposit,
        poolVault: committedOnlyPool.poolVault,
        depositorUsdcAta: depositorAta.address,
        treasuryUsdcAccount: treasuryUsdcAta,
        frontendOperator: null,
        frontendUsdcAta: null,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([depositor])
      .rpc();
    await expectTxFailure(
      program.methods
        .poolDeployToContract(toBn(50_000_000n))
        .accountsPartial({
          operator: operator.publicKey,
          pool: committedOnlyPool.pool,
          poolVault: committedOnlyPool.poolVault,
          contract: fixture.contract,
          state: statePda,
          contribution: deriveContribution(fixture.contract, committedOnlyPool.pool),
          escrow: deriveEscrow(fixture.contract, committedOnlyPool.pool),
          contractUsdcAccount: fixture.contractUsdcAta,
          borrower: fixture.borrower.publicKey,
          borrowerUsdcAccount: fixture.borrowerUsdcAta,
          approvedFunder: null,
          usdcMint,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([operator])
        .rpc(),
      "PoolLoanTypeMismatch",
    );

    const minLtvPool = await createPoolForOperator({
      operator,
      operatorAuth,
      capacity: 0n,
      minimumDeposit: 10_000n,
      minLtvBps: 12_000,
      poolName: "rules-ltv",
    });
    const minLtvDeposit = derivePoolDeposit(minLtvPool.pool, depositor.publicKey);
    await program.methods
      .depositToPool(toBn(60_000_000n))
      .accountsPartial({
        depositor: depositor.publicKey,
        pool: minLtvPool.pool,
        state: statePda,
        treasury: treasuryPda,
        poolDeposit: minLtvDeposit,
        poolVault: minLtvPool.poolVault,
        depositorUsdcAta: depositorAta.address,
        treasuryUsdcAccount: treasuryUsdcAta,
        frontendOperator: null,
        frontendUsdcAta: null,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([depositor])
      .rpc();
    await expectTxFailure(
      program.methods
        .poolDeployToContract(toBn(50_000_000n))
        .accountsPartial({
          operator: operator.publicKey,
          pool: minLtvPool.pool,
          poolVault: minLtvPool.poolVault,
          contract: fixture.contract,
          state: statePda,
          contribution: deriveContribution(fixture.contract, minLtvPool.pool),
          escrow: deriveEscrow(fixture.contract, minLtvPool.pool),
          contractUsdcAccount: fixture.contractUsdcAta,
          borrower: fixture.borrower.publicKey,
          borrowerUsdcAccount: fixture.borrowerUsdcAta,
          approvedFunder: null,
          usdcMint,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([operator])
        .rpc(),
      "PoolDeploymentRuleViolation",
    );

    const maxTermPool = await createPoolForOperator({
      operator,
      operatorAuth,
      capacity: 0n,
      minimumDeposit: 10_000n,
      maxTermDays: 15,
      poolName: "rules-term",
    });
    const maxTermDeposit = derivePoolDeposit(maxTermPool.pool, depositor.publicKey);
    await program.methods
      .depositToPool(toBn(60_000_000n))
      .accountsPartial({
        depositor: depositor.publicKey,
        pool: maxTermPool.pool,
        state: statePda,
        treasury: treasuryPda,
        poolDeposit: maxTermDeposit,
        poolVault: maxTermPool.poolVault,
        depositorUsdcAta: depositorAta.address,
        treasuryUsdcAccount: treasuryUsdcAta,
        frontendOperator: null,
        frontendUsdcAta: null,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([depositor])
      .rpc();
    await expectTxFailure(
      program.methods
        .poolDeployToContract(toBn(50_000_000n))
        .accountsPartial({
          operator: operator.publicKey,
          pool: maxTermPool.pool,
          poolVault: maxTermPool.poolVault,
          contract: fixture.contract,
          state: statePda,
          contribution: deriveContribution(fixture.contract, maxTermPool.pool),
          escrow: deriveEscrow(fixture.contract, maxTermPool.pool),
          contractUsdcAccount: fixture.contractUsdcAta,
          borrower: fixture.borrower.publicKey,
          borrowerUsdcAccount: fixture.borrowerUsdcAta,
          approvedFunder: null,
          usdcMint,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([operator])
        .rpc(),
      "PoolDeploymentRuleViolation",
    );
  });

  it("allows operator to return only free liquidity while paused", async () => {
    if (!canRunContractFlows) {
      return;
    }

    const operator = Keypair.generate();
    await airdropSol(connection, operator, 0.05);
    const operatorAuth = await authorizeOperator(operator);
    const { pool, poolVault } = await createPoolForOperator({
      operator,
      operatorAuth,
      rateBps: 1_000,
      capacity: 0n,
      minimumDeposit: 10_000n,
      withdrawalQueueEnabled: true,
      poolName: "return-pool",
    });

    const depositor = Keypair.generate();
    await airdropSol(connection, depositor, 0.05);
    const depositorAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      usdcMint,
      depositor.publicKey,
    );
    await mintTo(
      connection,
      payer,
      usdcMint,
      depositorAta.address,
      provider.wallet.publicKey,
      120_000_000n,
    );
    const poolDeposit = derivePoolDeposit(pool, depositor.publicKey);
    await program.methods
      .depositToPool(toBn(100_000_000n))
      .accountsPartial({
        depositor: depositor.publicKey,
        pool,
        state: statePda,
        treasury: treasuryPda,
        poolDeposit,
        poolVault,
        depositorUsdcAta: depositorAta.address,
        treasuryUsdcAccount: treasuryUsdcAta,
        frontendOperator: null,
        frontendUsdcAta: null,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([depositor])
      .rpc();

    const fixture = await createDebtContractFixture(70_000_000n);
    const contribution = deriveContribution(fixture.contract, pool);
    const escrow = deriveEscrow(fixture.contract, pool);
    await program.methods
      .poolDeployToContract(toBn(70_000_000n))
      .accountsPartial({
        operator: operator.publicKey,
        pool,
        poolVault,
        contract: fixture.contract,
        state: statePda,
        contribution,
        escrow,
        contractUsdcAccount: fixture.contractUsdcAta,
        borrower: fixture.borrower.publicKey,
        borrowerUsdcAccount: fixture.borrowerUsdcAta,
        approvedFunder: null,
        usdcMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([operator])
      .rpc();

    await program.methods
      .pausePool()
      .accountsPartial({ operator: operator.publicKey, pool })
      .signers([operator])
      .rpc();

    const preBalance = (await getAccount(connection, depositorAta.address)).amount;
    await program.methods
      .operatorReturnDeposit()
      .accountsPartial({
        operator: operator.publicKey,
        pool,
        poolDeposit,
        depositor: depositor.publicKey,
        depositorUsdcAta: depositorAta.address,
        poolVault,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([operator])
      .rpc();
    const postBalance = (await getAccount(connection, depositorAta.address)).amount;

    const postDeposit = await program.account.poolDeposit.fetch(poolDeposit);
    const postPool = await program.account.poolState.fetch(pool);

    assert.equal(postDeposit.depositAmount.toString(), "70000000");
    assert.equal(postPool.currentUtilized.toString(), "70000000");
    assert.equal(postPool.currentTotalDeposits.toString(), "70000000");
    assert.isTrue(postBalance - preBalance >= 30_000_000n);
  });

  it("deploys pool funds to contract, handles queue withdrawals, and claims escrow", async () => {
    if (!canRunContractFlows) {
      return;
    }

    const operator = Keypair.generate();
    await airdropSol(connection, operator, 0.05);
    const operatorAuth = await authorizeOperator(operator);
    const { pool, poolVault } = await createPoolForOperator({
      operator,
      operatorAuth,
      rateBps: 1_000,
      capacity: 0n,
      minimumDeposit: 10_000n,
      withdrawalQueueEnabled: true,
      poolName: "deploy-pool",
    });

    const depositor = Keypair.generate();
    await airdropSol(connection, depositor, 0.05);
    const depositorAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      usdcMint,
      depositor.publicKey,
    );
    await mintTo(
      connection,
      payer,
      usdcMint,
      depositorAta.address,
      provider.wallet.publicKey,
      120_000_000n,
    );
    const poolDeposit = derivePoolDeposit(pool, depositor.publicKey);
    await program.methods
      .depositToPool(toBn(100_000_000n))
      .accountsPartial({
        depositor: depositor.publicKey,
        pool,
        state: statePda,
        treasury: treasuryPda,
        poolDeposit,
        poolVault,
        depositorUsdcAta: depositorAta.address,
        treasuryUsdcAccount: treasuryUsdcAta,
        frontendOperator: null,
        frontendUsdcAta: null,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([depositor])
      .rpc();

    const fixture = await createDebtContractFixture(100_000_000n);
    const contribution = deriveContribution(fixture.contract, pool);
    const escrow = deriveEscrow(fixture.contract, pool);

    await expectTxFailure(
      program.methods
        .poolDeployToContract(toBn(150_000_000n))
        .accountsPartial({
          operator: operator.publicKey,
          pool,
          poolVault,
          contract: fixture.contract,
          state: statePda,
          contribution,
          escrow,
          contractUsdcAccount: fixture.contractUsdcAta,
          borrower: fixture.borrower.publicKey,
          borrowerUsdcAccount: fixture.borrowerUsdcAta,
          approvedFunder: null,
          usdcMint,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([operator])
        .rpc(),
      "InsufficientPoolLiquidity",
    );

    await program.methods
      .poolDeployToContract(toBn(100_000_000n))
      .accountsPartial({
        operator: operator.publicKey,
        pool,
        poolVault,
        contract: fixture.contract,
        state: statePda,
        contribution,
        escrow,
        contractUsdcAccount: fixture.contractUsdcAta,
        borrower: fixture.borrower.publicKey,
        borrowerUsdcAccount: fixture.borrowerUsdcAta,
        approvedFunder: null,
        usdcMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([operator])
      .rpc();

    const contributionAccount = await program.account.lenderContribution.fetch(contribution);
    const escrowAccount = await program.account.lenderEscrow.fetch(escrow);
    assert.equal(contributionAccount.lender.toBase58(), pool.toBase58());
    assert.equal(escrowAccount.lender.toBase58(), pool.toBase58());

    await expectTxFailure(
      program.methods
        .closePool()
        .accountsPartial({ operator: operator.publicKey, pool })
        .signers([operator])
        .rpc(),
      "PoolNotEmpty",
    );

    await program.methods
      .withdrawFromPool(toBn(100_000_000n))
      .accountsPartial({
        depositor: depositor.publicKey,
        pool,
        poolDeposit,
        poolVault,
        depositorUsdcAta: depositorAta.address,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([depositor])
      .rpc();
    let queuedDeposit = await program.account.poolDeposit.fetch(poolDeposit);
    assert.isTrue(queuedDeposit.withdrawalRequested);
    assert.equal(queuedDeposit.withdrawalRequestedAmount.toString(), "100000000");

    const escrowUsdcAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      usdcMint,
      escrow,
      true,
    );

    await program.methods
      .makePaymentWithDistribution(toBn(100_000_000n))
      .accountsPartial({
        contract: fixture.contract,
        operationsFund: fixture.operationsFund,
        state: statePda,
        borrower: fixture.borrower.publicKey,
        borrowerUsdcAccount: fixture.borrowerUsdcAta,
        contractUsdcAccount: fixture.contractUsdcAta,
        contractCollateralAccount: fixture.contractCollateralAta,
        borrowerCollateralAccount: fixture.borrowerCollateralAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts([
        { pubkey: contribution, isSigner: false, isWritable: false },
        { pubkey: escrow, isSigner: false, isWritable: true },
        { pubkey: escrowUsdcAta.address, isSigner: false, isWritable: true },
      ])
      .signers([fixture.borrower])
      .rpc();

    await program.methods
      .poolClaimFromEscrow()
      .accountsPartial({
        caller: provider.wallet.publicKey,
        treasury: treasuryPda,
        pool,
        poolVault,
        contract: fixture.contract,
        escrow,
        escrowUsdcAccount: escrowUsdcAta.address,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    await program.methods
      .processPoolWithdrawal()
      .accountsPartial({
        crank: provider.wallet.publicKey,
        pool,
        poolDeposit,
        depositor: depositor.publicKey,
        depositorUsdcAta: depositorAta.address,
        poolVault,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const postProcessDeposit = await program.account.poolDeposit.fetch(poolDeposit);
    const postProcessPool = await program.account.poolState.fetch(pool);
    assert.equal(postProcessDeposit.depositAmount.toString(), "0");
    assert.equal(postProcessPool.currentUtilized.toString(), "0");
    assert.equal(postProcessPool.currentTotalDeposits.toString(), "0");

    const depositorTokenAccount = await getAccount(connection, depositorAta.address);
    assert.isTrue(
      depositorTokenAccount.amount >= 100_000_000n,
      "depositor should recover queued withdrawal amount",
    );

    await program.methods
      .closePool()
      .accountsPartial({ operator: operator.publicKey, pool })
      .signers([operator])
      .rpc();
  });
});
