import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
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

import { airdropSol, refundTrackedKeypairs } from "./test_helpers.ts";

const BPF_UPGRADEABLE_LOADER_ID = new PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111",
);
const CLOCK_SYSVAR_ID = new PublicKey(
  "SysvarC1ock11111111111111111111111111111111",
);
const POOL_IDLE_EXPIRY_SECONDS = 30 * 24 * 60 * 60;

function toBn(value: bigint | number): anchor.BN {
  return new anchor.BN(value.toString());
}

function u64ToLeBytes(value: anchor.BN): Buffer {
  return value.toArrayLike(Buffer, "le", 8);
}

function encodePoolName(name: string): number[] {
  const buf = Buffer.alloc(32);
  buf.write(name.slice(0, 32), "utf8");
  return Array.from(buf);
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

describe("Pool auto-expiration", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const connection = provider.connection;
  const payer = (provider.wallet as anchor.Wallet & { payer: Keypair }).payer;

  const workspaceProgram: any = anchor.workspace.Stendar;
  const programId = new PublicKey(
    process.env.STENDAR_PROGRAM_ID ??
      process.env.SOLANA_PROGRAM_ID ??
      workspaceProgram.programId.toBase58(),
  );
  const program: any = new Program<any>(
    {
      ...(workspaceProgram.idl as Record<string, unknown>),
      address: programId.toBase58(),
    } as any,
    provider,
  );

  const [statePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("global_state")],
    program.programId,
  );
  const [treasuryPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("treasury")],
    program.programId,
  );
  const [programDataPda] = PublicKey.findProgramAddressSync(
    [program.programId.toBuffer()],
    BPF_UPGRADEABLE_LOADER_ID,
  );

  let usdcMint: PublicKey;
  let treasuryUsdcAta: PublicKey;
  let poolSeedCounter = 120_000;
  let contractSeedCounter = 130_000;
  let oracleSeedCounter = 140_000;
  let collateralMint: PublicKey | null = null;
  let mockOracleFeed: PublicKey | null = null;

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

  function derivePendingPoolChange(pool: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("pending_pool_change"), pool.toBuffer()],
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

  function deriveMockOracle(feedSeed: anchor.BN): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("mock_oracle_price_feed"), u64ToLeBytes(feedSeed)],
      program.programId,
    )[0];
  }

  async function getClockUnixTimestamp(): Promise<number> {
    const clockInfo = await connection.getAccountInfo(CLOCK_SYSVAR_ID, "confirmed");
    assert.ok(clockInfo, "Clock sysvar account must exist");
    return Number(clockInfo.data.readBigInt64LE(32));
  }

  async function warpForwardSlots(slots: number): Promise<void> {
    const jump = Math.max(1, Math.floor(slots));
    const currentSlot = await connection.getSlot("confirmed");
    await (connection as any)._rpcRequest("warpSlot", [currentSlot + jump]);
  }

  async function advanceClockToTimestamp(targetTimestamp: number): Promise<number> {
    let current = await getClockUnixTimestamp();
    let safety = 0;

    while (current < targetTimestamp - 120) {
      const remaining = targetTimestamp - current;
      const jumpSlots = Math.max(1, remaining - 120);
      await warpForwardSlots(jumpSlots);
      current = await getClockUnixTimestamp();
      safety += 1;
      if (safety > 80) {
        throw new Error(
          `Failed to advance clock near ${targetTimestamp}; current=${current}`,
        );
      }
    }

    while (current < targetTimestamp) {
      await warpForwardSlots(1);
      current = await getClockUnixTimestamp();
      safety += 1;
      if (safety > 10_000) {
        throw new Error(
          `Failed to reach target timestamp ${targetTimestamp}; current=${current}`,
        );
      }
    }

    return current;
  }

  async function ensureStateInitialized(): Promise<void> {
    const stateInfo = await connection.getAccountInfo(statePda);
    if (stateInfo !== null) {
      return;
    }
    await program.methods
      .initialize()
      .accountsPartial({
        state: statePda,
        authority: provider.wallet.publicKey,
        program: program.programId,
        programData: programDataPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  async function ensureTreasury(botAuthority: PublicKey): Promise<void> {
    const treasuryInfo = await connection.getAccountInfo(treasuryPda);
    if (treasuryInfo === null) {
      usdcMint = await createMint(
        connection,
        payer,
        provider.wallet.publicKey,
        null,
        6,
      );
      await program.methods
        .initializeTreasury(botAuthority, usdcMint)
        .accounts({
          treasury: treasuryPda,
          state: statePda,
          authority: provider.wallet.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    } else {
      const treasury = (await program.account.treasury.fetch(treasuryPda)) as any;
      usdcMint = treasury.usdcMint as PublicKey;
      if ((treasury.botAuthority as PublicKey).toBase58() !== botAuthority.toBase58()) {
        await program.methods
          .updateBotAuthority()
          .accounts({
            treasury: treasuryPda,
            authority: provider.wallet.publicKey,
            newBotAuthority: botAuthority,
          })
          .rpc();
      }
    }

    treasuryUsdcAta = (
      await getOrCreateAssociatedTokenAccount(
        connection,
        payer,
        usdcMint,
        treasuryPda,
        true,
      )
    ).address;
  }

  async function authorizeOperator(operator: Keypair): Promise<PublicKey> {
    const operatorAuth = deriveOperatorAuth(operator.publicKey);
    await program.methods
      .authorizePoolOperator()
      .accounts({
        state: statePda,
        authority: provider.wallet.publicKey,
        operatorAuth,
        operator: operator.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    return operatorAuth;
  }

  async function createPoolForOperator(params: {
    operator: Keypair;
    operatorAuth: PublicKey;
    poolName?: string;
    capacity?: bigint;
    minimumDeposit?: bigint;
  }): Promise<{ pool: PublicKey; poolVault: PublicKey; poolSeed: anchor.BN }> {
    const poolSeed = nextPoolSeed();
    const pool = derivePool(params.operator.publicKey, poolSeed);
    const poolVault = getAssociatedTokenAddressSync(usdcMint, pool, true);
    await program.methods
      .createPool(
        poolSeed,
        encodePoolName(params.poolName ?? "expiry-pool"),
        1_200,
        true,
        toBn(params.capacity ?? 0n),
        toBn(params.minimumDeposit ?? 10_000n),
        false,
        0,
        0,
        0,
      )
      .accounts({
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

  async function mintAndDeposit(params: {
    pool: PublicKey;
    poolVault: PublicKey;
    depositor: Keypair;
    amount: bigint;
  }): Promise<{ poolDeposit: PublicKey; depositorUsdcAta: PublicKey }> {
    const depositorUsdcAta = (
      await getOrCreateAssociatedTokenAccount(
        connection,
        payer,
        usdcMint,
        params.depositor.publicKey,
      )
    ).address;
    await mintTo(
      connection,
      payer,
      usdcMint,
      depositorUsdcAta,
      provider.wallet.publicKey,
      params.amount + 5_000_000n,
    );
    const poolDeposit = derivePoolDeposit(params.pool, params.depositor.publicKey);
    await program.methods
      .depositToPool(toBn(params.amount))
      .accounts({
        depositor: params.depositor.publicKey,
        pool: params.pool,
        state: statePda,
        treasury: treasuryPda,
        poolDeposit,
        poolVault: params.poolVault,
        depositorUsdcAta,
        treasuryUsdcAccount: treasuryUsdcAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([params.depositor])
      .rpc();
    return { poolDeposit, depositorUsdcAta };
  }

  async function ensureCollateralSetup(): Promise<void> {
    const [registryPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("collateral_registry")],
      program.programId,
    );

    if (collateralMint === null) {
      collateralMint = await createMint(
        connection,
        payer,
        provider.wallet.publicKey,
        null,
        8,
      );
    }

    const oracleSeed = nextOracleSeed();
    const oraclePda = deriveMockOracle(oracleSeed);
    const existingOracle = await connection.getAccountInfo(oraclePda);
    const now = Math.floor(Date.now() / 1000);
    if (existingOracle === null) {
      await (program as any).methods
        .initializeMockOraclePriceFeed(oracleSeed, toBn(200_000_000n), -8, toBn(now))
        .accounts({
          authority: provider.wallet.publicKey,
          state: statePda,
          mockOraclePriceFeed: oraclePda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    } else {
      await (program as any).methods
        .setMockOraclePriceFeed(toBn(200_000_000n), -8, toBn(now))
        .accounts({
          authority: provider.wallet.publicKey,
          state: statePda,
          mockOraclePriceFeed: oraclePda,
        })
        .rpc();
    }
    mockOracleFeed = oraclePda;

    const registryInfo = await connection.getAccountInfo(registryPda);
    if (registryInfo === null) {
      await program.methods
        .initializeCollateralRegistry()
        .accounts({
          authority: provider.wallet.publicKey,
          state: statePda,
          collateralRegistry: registryPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    }

    const registry = (await program.account.collateralRegistry.fetch(registryPda)) as any;
    const exists = registry.collateralTypes.some((entry: any) =>
      (entry.mint as PublicKey).toBase58() === (collateralMint as PublicKey).toBase58(),
    );
    if (!exists) {
      await program.methods
        .addCollateralType(mockOracleFeed, 8, 500, 11_000)
        .accounts({
          authority: provider.wallet.publicKey,
          state: statePda,
          collateralRegistry: registryPda,
          collateralMint,
          oraclePriceFeed: mockOracleFeed,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    }
  }

  async function createUtilizedPoolFixture(
    bot: Keypair,
  ): Promise<{ pool: PublicKey; poolVault: PublicKey }> {
    await ensureCollateralSetup();
    const operator = Keypair.generate();
    const depositor = Keypair.generate();
    const borrower = Keypair.generate();
    await Promise.all([
      airdropSol(connection, operator, 0.1),
      airdropSol(connection, depositor, 0.1),
      airdropSol(connection, borrower, 0.1),
    ]);

    const operatorAuth = await authorizeOperator(operator);
    const { pool, poolVault } = await createPoolForOperator({
      operator,
      operatorAuth,
      poolName: "utilized-pool",
      minimumDeposit: 10_000n,
    });

    const targetAmount = 50_000_000n;
    const { poolDeposit, depositorUsdcAta } = await mintAndDeposit({
      pool,
      poolVault,
      depositor,
      amount: targetAmount,
    });

    const contractSeed = nextContractSeed();
    const [contract] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("debt_contract"),
        borrower.publicKey.toBuffer(),
        u64ToLeBytes(contractSeed),
      ],
      program.programId,
    );
    const [operationsFund] = PublicKey.findProgramAddressSync(
      [Buffer.from("operations_fund"), contract.toBuffer()],
      program.programId,
    );

    const borrowerCollateralAta = (
      await getOrCreateAssociatedTokenAccount(
        connection,
        payer,
        collateralMint as PublicKey,
        borrower.publicKey,
      )
    ).address;
    const contractCollateralAta = (
      await getOrCreateAssociatedTokenAccount(
        connection,
        payer,
        collateralMint as PublicKey,
        contract,
        true,
      )
    ).address;
    const borrowerUsdcAta = (
      await getOrCreateAssociatedTokenAccount(
        connection,
        payer,
        usdcMint,
        borrower.publicKey,
      )
    ).address;
    const contractUsdcAta = (
      await getOrCreateAssociatedTokenAccount(connection, payer, usdcMint, contract, true)
    ).address;

    await mintTo(
      connection,
      payer,
      collateralMint as PublicKey,
      borrowerCollateralAta,
      provider.wallet.publicKey,
      8_000_000_000n,
    );
    await mintTo(
      connection,
      payer,
      usdcMint,
      borrowerUsdcAta,
      provider.wallet.publicKey,
      targetAmount + 5_000_000n,
    );

    const [registryPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("collateral_registry")],
      program.programId,
    );

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
      .accounts({
        contract,
        operationsFund,
        state: statePda,
        treasury: treasuryPda,
        borrower: borrower.publicKey,
        systemProgram: SystemProgram.programId,
        collateralRegistry: registryPda,
        collateralMint,
        borrowerCollateralAta,
        contractCollateralAta,
        priceFeedAccount: mockOracleFeed,
        usdcMint,
        contractUsdcAta,
        borrowerUsdcAta,
        treasuryUsdcAccount: treasuryUsdcAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .signers([borrower])
      .rpc();

    const contribution = deriveContribution(contract, pool);
    const escrow = deriveEscrow(contract, pool);
    await program.methods
      .poolDeployToContract(toBn(targetAmount))
      .accounts({
        operator: operator.publicKey,
        pool,
        poolVault,
        contract,
        state: statePda,
        contribution,
        escrow,
        contractUsdcAccount: contractUsdcAta,
        borrower: borrower.publicKey,
        borrowerUsdcAccount: borrowerUsdcAta,
        approvedFunder: null,
        usdcMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([operator])
      .rpc();

    // Keep these references live for deterministic account ownership in replayed tests.
    void poolDeposit;
    void depositorUsdcAta;
    void bot;

    return { pool, poolVault };
  }

  before(async () => {
    await ensureStateInitialized();
    const bot = Keypair.generate();
    await airdropSol(connection, bot, 0.05);
    await ensureTreasury(bot.publicKey);
    await (program as any).methods
      .updateFeeRates(0, 0, null, null, null)
      .accounts({
        state: statePda,
        authority: provider.wallet.publicKey,
      })
      .rpc();
  });

  after(async () => {
    await refundTrackedKeypairs(connection);
  });

  it("sets idle_since on newly created pool", async () => {
    const operator = Keypair.generate();
    await airdropSol(connection, operator, 0.05);
    const operatorAuth = await authorizeOperator(operator);
    const { pool } = await createPoolForOperator({
      operator,
      operatorAuth,
      poolName: "idle-since-create",
    });
    const poolAccount = (await program.account.poolState.fetch(pool)) as any;
    assert.equal(
      poolAccount.idleSince.toString(),
      poolAccount.createdAt.toString(),
      "new pools should start idle",
    );
  });

  it("resets idle_since to zero after deposit", async () => {
    const operator = Keypair.generate();
    const depositor = Keypair.generate();
    await Promise.all([
      airdropSol(connection, operator, 0.05),
      airdropSol(connection, depositor, 0.05),
    ]);
    const operatorAuth = await authorizeOperator(operator);
    const { pool, poolVault } = await createPoolForOperator({
      operator,
      operatorAuth,
      poolName: "idle-since-deposit",
    });
    await mintAndDeposit({
      pool,
      poolVault,
      depositor,
      amount: 100_000_000n,
    });
    const poolAccount = (await program.account.poolState.fetch(pool)) as any;
    assert.equal(poolAccount.idleSince.toString(), "0");
  });

  it("keeps idle_since at zero while pool remains funded", async () => {
    const operator = Keypair.generate();
    const depositor = Keypair.generate();
    await Promise.all([
      airdropSol(connection, operator, 0.05),
      airdropSol(connection, depositor, 0.05),
    ]);
    const operatorAuth = await authorizeOperator(operator);
    const { pool, poolVault } = await createPoolForOperator({
      operator,
      operatorAuth,
      poolName: "idle-since-funded",
    });
    const { poolDeposit, depositorUsdcAta } = await mintAndDeposit({
      pool,
      poolVault,
      depositor,
      amount: 120_000_000n,
    });
    await program.methods
      .withdrawFromPool(toBn(20_000_000n))
      .accounts({
        depositor: depositor.publicKey,
        pool,
        poolDeposit,
        poolVault,
        depositorUsdcAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([depositor])
      .rpc();
    const poolAccount = (await program.account.poolState.fetch(pool)) as any;
    assert.equal(poolAccount.idleSince.toString(), "0");
    assert.equal(poolAccount.currentTotalDeposits.toString(), "100000000");
  });

  it("sets idle_since when all deposits are withdrawn with zero utilization", async () => {
    const operator = Keypair.generate();
    const depositor = Keypair.generate();
    await Promise.all([
      airdropSol(connection, operator, 0.05),
      airdropSol(connection, depositor, 0.05),
    ]);
    const operatorAuth = await authorizeOperator(operator);
    const { pool, poolVault } = await createPoolForOperator({
      operator,
      operatorAuth,
      poolName: "idle-since-withdraw",
    });
    const { poolDeposit, depositorUsdcAta } = await mintAndDeposit({
      pool,
      poolVault,
      depositor,
      amount: 60_000_000n,
    });
    await program.methods
      .withdrawFromPool(toBn(60_000_000n))
      .accounts({
        depositor: depositor.publicKey,
        pool,
        poolDeposit,
        poolVault,
        depositorUsdcAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([depositor])
      .rpc();
    const poolAccount = (await program.account.poolState.fetch(pool)) as any;
    assert.equal(poolAccount.currentTotalDeposits.toString(), "0");
    assert.equal(poolAccount.currentUtilized.toString(), "0");
    assert.isTrue(new anchor.BN(poolAccount.idleSince).gt(new anchor.BN(0)));
  });

  it("keeps idle_since at zero when utilization drops but deposits remain", async () => {
    const bot = Keypair.generate();
    await airdropSol(connection, bot, 0.05);
    await ensureTreasury(bot.publicKey);
    const { pool } = await createUtilizedPoolFixture(bot);
    const poolAccount = (await program.account.poolState.fetch(pool)) as any;
    assert.isTrue(
      new anchor.BN(poolAccount.currentUtilized).gt(new anchor.BN(0)),
      "fixture should create non-zero utilization",
    );
    assert.equal(poolAccount.idleSince.toString(), "0");
  });

  it("allows bot to close idle pool after 30 days and refunds operator rent", async () => {
    const bot = Keypair.generate();
    const operator = Keypair.generate();
    await Promise.all([
      airdropSol(connection, bot, 0.05),
      airdropSol(connection, operator, 0.05),
    ]);
    await ensureTreasury(bot.publicKey);
    const operatorAuth = await authorizeOperator(operator);
    const { pool } = await createPoolForOperator({
      operator,
      operatorAuth,
      poolName: "expire-after-30-days",
    });
    const poolAccount = (await program.account.poolState.fetch(pool)) as any;
    const target = Number(poolAccount.idleSince) + POOL_IDLE_EXPIRY_SECONDS + 5;
    await advanceClockToTimestamp(target);

    const operatorBalanceBefore = await connection.getBalance(operator.publicKey, "confirmed");
    await program.methods
      .expireIdlePool()
      .accounts({
        botAuthority: bot.publicKey,
        treasury: treasuryPda,
        operatorReceiver: operator.publicKey,
        pool,
      })
      .signers([bot])
      .rpc();

    const operatorBalanceAfter = await connection.getBalance(operator.publicKey, "confirmed");
    const poolInfoAfter = await connection.getAccountInfo(pool, "confirmed");
    assert.isNull(poolInfoAfter, "pool account should be closed after expiration");
    assert.isTrue(
      operatorBalanceAfter > operatorBalanceBefore,
      "operator should receive closed-account rent",
    );
  });

  it("rejects bot close before 30 days", async () => {
    const bot = Keypair.generate();
    const operator = Keypair.generate();
    await Promise.all([
      airdropSol(connection, bot, 0.05),
      airdropSol(connection, operator, 0.05),
    ]);
    await ensureTreasury(bot.publicKey);
    const operatorAuth = await authorizeOperator(operator);
    const { pool } = await createPoolForOperator({
      operator,
      operatorAuth,
      poolName: "expire-too-early",
    });
    await expectTxFailure(
      program.methods
        .expireIdlePool()
        .accounts({
          botAuthority: bot.publicKey,
          treasury: treasuryPda,
          operatorReceiver: operator.publicKey,
          pool,
        })
        .signers([bot])
        .rpc(),
      "PoolNotIdle",
    );
  });

  it("rejects bot close when deposits remain non-zero", async () => {
    const bot = Keypair.generate();
    const operator = Keypair.generate();
    const depositor = Keypair.generate();
    await Promise.all([
      airdropSol(connection, bot, 0.05),
      airdropSol(connection, operator, 0.05),
      airdropSol(connection, depositor, 0.05),
    ]);
    await ensureTreasury(bot.publicKey);
    const operatorAuth = await authorizeOperator(operator);
    const { pool, poolVault } = await createPoolForOperator({
      operator,
      operatorAuth,
      poolName: "expire-not-empty",
    });
    await mintAndDeposit({
      pool,
      poolVault,
      depositor,
      amount: 25_000_000n,
    });
    await expectTxFailure(
      program.methods
        .expireIdlePool()
        .accounts({
          botAuthority: bot.publicKey,
          treasury: treasuryPda,
          operatorReceiver: operator.publicKey,
          pool,
        })
        .signers([bot])
        .rpc(),
      "PoolNotEmpty",
    );
  });

  it("rejects bot close when utilization is non-zero", async () => {
    const bot = Keypair.generate();
    await airdropSol(connection, bot, 0.05);
    await ensureTreasury(bot.publicKey);
    const { pool } = await createUtilizedPoolFixture(bot);
    await expectTxFailure(
      program.methods
        .expireIdlePool()
        .accounts({
          botAuthority: bot.publicKey,
          treasury: treasuryPda,
          operatorReceiver: (await program.account.poolState.fetch(pool)).operator,
          pool,
        })
        .signers([bot])
        .rpc(),
      "PoolUtilizationNotZero",
    );
  });

  it("rejects non-bot signer", async () => {
    const bot = Keypair.generate();
    const attacker = Keypair.generate();
    const operator = Keypair.generate();
    await Promise.all([
      airdropSol(connection, bot, 0.05),
      airdropSol(connection, attacker, 0.05),
      airdropSol(connection, operator, 0.05),
    ]);
    await ensureTreasury(bot.publicKey);
    const operatorAuth = await authorizeOperator(operator);
    const { pool } = await createPoolForOperator({
      operator,
      operatorAuth,
      poolName: "expire-non-bot",
    });
    const poolAccount = (await program.account.poolState.fetch(pool)) as any;
    const target = Number(poolAccount.idleSince) + POOL_IDLE_EXPIRY_SECONDS + 5;
    await advanceClockToTimestamp(target);

    await expectTxFailure(
      program.methods
        .expireIdlePool()
        .accounts({
          botAuthority: attacker.publicKey,
          treasury: treasuryPda,
          operatorReceiver: operator.publicKey,
          pool,
        })
        .signers([attacker])
        .rpc(),
      "UnauthorizedBotOperation",
    );
  });

  it("closes pending pool change PDA alongside pool on expiration", async () => {
    const bot = Keypair.generate();
    const operator = Keypair.generate();
    await Promise.all([
      airdropSol(connection, bot, 0.05),
      airdropSol(connection, operator, 0.1),
    ]);
    await ensureTreasury(bot.publicKey);
    const operatorAuth = await authorizeOperator(operator);
    const { pool } = await createPoolForOperator({
      operator,
      operatorAuth,
      poolName: "expire-with-pending",
    });

    const pendingChange = derivePendingPoolChange(pool);
    await program.methods
      .proposePoolChanges(1_500, null, null, null, null, null, null, null)
      .accounts({
        operator: operator.publicKey,
        pool,
        pendingChange,
        systemProgram: SystemProgram.programId,
      })
      .signers([operator])
      .rpc();

    const pendingBefore = await connection.getAccountInfo(pendingChange, "confirmed");
    assert.isNotNull(pendingBefore, "pending change PDA should exist before expiry");

    const poolAccount = (await program.account.poolState.fetch(pool)) as any;
    const target = Number(poolAccount.idleSince) + POOL_IDLE_EXPIRY_SECONDS + 5;
    await advanceClockToTimestamp(target);

    const operatorBalanceBefore = await connection.getBalance(operator.publicKey, "confirmed");
    await program.methods
      .expireIdlePool()
      .accounts({
        botAuthority: bot.publicKey,
        treasury: treasuryPda,
        operatorReceiver: operator.publicKey,
        pool,
        pendingChange,
      })
      .signers([bot])
      .rpc();

    const poolAfter = await connection.getAccountInfo(pool, "confirmed");
    assert.isNull(poolAfter, "pool account should be closed");

    const pendingAfter = await connection.getAccountInfo(pendingChange, "confirmed");
    assert.isNull(pendingAfter, "pending change PDA should be closed");

    const operatorBalanceAfter = await connection.getBalance(operator.publicKey, "confirmed");
    assert.isTrue(
      operatorBalanceAfter > operatorBalanceBefore,
      "operator should receive rent from both closed accounts",
    );
  });
});
