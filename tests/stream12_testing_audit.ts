import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import type { Stendar } from "../target/types/stendar";
import { assert } from "chai";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createMint,
  createSyncNativeInstruction,
  getAccount,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { buildMockPythPriceAccountData } from "./mock_oracle_utils.ts";
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
  expectAnchorEnumVariant,
} from "./test_helpers.ts";

const MAX_PRICE_AGE_CREATION_SECONDS = 120;

let contractSeedNonce = 800_000;
let oracleSeedNonce = 42_000;

function nextContractSeed(): anchor.BN {
  contractSeedNonce += 1;
  return new anchor.BN(contractSeedNonce);
}

function nextOracleSeed(): anchor.BN {
  oracleSeedNonce += 1;
  return new anchor.BN(oracleSeedNonce);
}


function bigintToSafeNumber(value: bigint): number {
  const asNumber = Number(value);
  if (!Number.isSafeInteger(asNumber)) {
    throw new Error(`value ${value.toString()} exceeds safe integer range`);
  }
  return asNumber;
}

function absBigInt(value: bigint): bigint {
  return value < 0n ? -value : value;
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


type ActiveCollateralType = {
  mint: PublicKey;
  oraclePriceFeed: PublicKey;
  decimals: number;
  liquidationBufferBps: number;
  minCommittedFloorBps: number;
};

type ContractFixture = {
  borrower: anchor.web3.Keypair;
  contractSeed: anchor.BN;
  oracleFeedSeed: anchor.BN;
  contractPda: PublicKey;
  operationsFundPda: PublicKey;
  collateralType: ActiveCollateralType;
  collateralAmount: bigint;
  targetAmount: bigint;
  ltvFloorBps: number;
  loanType: "demand" | "committed";
  usdcMint: PublicKey;
  borrowerCollateralAta: PublicKey;
  contractCollateralAta: PublicKey;
  borrowerUsdcAta: PublicKey;
  contractUsdcAta: PublicKey;
  treasuryUsdcAta: PublicKey;
};

type LenderPosition = {
  lender: anchor.web3.Keypair;
  amount: bigint;
  contributionPda: PublicKey;
  escrowPda: PublicKey;
  lenderUsdcAta: PublicKey;
  escrowUsdcAta: PublicKey;
};

describe("Stream 12 testing audit", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

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
  const connection = provider.connection;
  const hasRegisterFrontendInstruction = hasIdlInstruction(
    workspaceProgram.idl as { instructions?: Array<{ name?: string }> },
    "register_frontend",
    "registerFrontend",
  );
  after(async () => {
    await refundTrackedKeypairs(connection);
  });
  const payer = (provider.wallet as anchor.Wallet & { payer: anchor.web3.Keypair }).payer;
  let canonicalUsdcMint: PublicKey | null = null;

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
  const [testClockOffsetPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("test_clock_offset")],
    program.programId,
  );

  function mockOraclePda(feedSeed: anchor.BN): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("mock_oracle_price_feed"), u64ToLeBytes(feedSeed)],
      program.programId,
    )[0];
  }

  function computeCollateralAmountForTargetValue(
    targetUsdcValue: bigint,
    decimals: number,
    price: bigint,
    exponent: number,
  ): bigint {
    assert.equal(exponent, -8, "helper expects exponent -8 for deterministic tests");
    const numerator = targetUsdcValue * 10n ** BigInt(decimals) * 100_000_000n;
    const denominator = price * 1_000_000n;
    return (numerator + denominator - 1n) / denominator;
  }

  function computeThresholdPrice(
    collateralAmount: bigint,
    collateralDecimals: number,
    outstandingUsdc: bigint,
    thresholdBps: number,
  ): bigint {
    const collateralValueAtThreshold = (outstandingUsdc * BigInt(thresholdBps)) / 10_000n;
    return (
      (collateralValueAtThreshold * 10n ** BigInt(collateralDecimals) * 100_000_000n) /
      (collateralAmount * 1_000_000n)
    );
  }

  async function ensurePlatformInitialized(): Promise<void> {
    const stateInfo = await connection.getAccountInfo(statePda);
    if (!stateInfo) {
      await program.methods
        .initialize()
        .accounts({
          state: statePda,
          authority: provider.wallet.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    }

    const treasuryInfo = await connection.getAccountInfo(treasuryPda);
    if (!treasuryInfo) {
      const treasuryUsdcMint =
        canonicalUsdcMint ?? await createMint(connection, payer, provider.wallet.publicKey, null, 6);
      canonicalUsdcMint = treasuryUsdcMint;
      await program.methods
        .initializeTreasury(provider.wallet.publicKey, treasuryUsdcMint)
        .accounts({
          state: statePda,
          treasury: treasuryPda,
          authority: provider.wallet.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    }
  }

  async function getOnchainUnixTimestamp(): Promise<number> {
    const slot = await connection.getSlot("processed");
    const blockTime = await connection.getBlockTime(slot);
    return blockTime ?? Math.floor(Date.now() / 1000);
  }

  async function warpForwardSlots(slots: number): Promise<void> {
    const currentSlot = await connection.getSlot("confirmed");
    const warpConnection = connection as unknown as {
      _rpcRequest(
        methodName: string,
        params: unknown[],
      ): Promise<{ error?: { message?: string } }>;
    };
    const response = await warpConnection._rpcRequest("warpSlot", [
      currentSlot + slots,
    ]);
    if (response.error) {
      throw new Error(response.error.message ?? "warpSlot failed");
    }
  }

  async function getCanonicalUsdcMint(): Promise<PublicKey> {
    if (canonicalUsdcMint !== null) {
      return canonicalUsdcMint;
    }

    const treasury = await program.account.treasury.fetch(treasuryPda);
    if (!treasury.usdcMint.equals(PublicKey.default) && await isValidSplMint(connection, treasury.usdcMint)) {
      canonicalUsdcMint = treasury.usdcMint as PublicKey;
      return canonicalUsdcMint;
    }

    canonicalUsdcMint = await createMint(connection, payer, provider.wallet.publicKey, null, 6);
    return canonicalUsdcMint;
  }

  async function localRegisterFrontendOperator(
    operator: anchor.web3.Keypair,
  ): Promise<PublicKey> {
    return registerFrontendOperator(connection, program.programId, operator);
  }

  async function ensureCollateralRegistryInitialized(): Promise<void> {
    const registryInfo = await connection.getAccountInfo(collateralRegistryPda);
    if (registryInfo === null) {
      await program.methods
        .initializeCollateralRegistry()
        .accounts({
          authority: provider.wallet.publicKey,
          state: statePda,
          collateralRegistry: collateralRegistryPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    }
    await program.methods
      .resetCollateralRegistry()
      .accounts({
        authority: provider.wallet.publicKey,
        state: statePda,
        collateralRegistry: collateralRegistryPda,
      })
      .rpc();

    const guardUsdcMint = await getCanonicalUsdcMint();
    await program.methods
      .resetTreasuryUsdcMint(guardUsdcMint)
      .accounts({
        authority: provider.wallet.publicKey,
        state: statePda,
        treasury: treasuryPda,
      })
      .rpc();

    await program.methods
      .updateBotAuthority()
      .accounts({
        treasury: treasuryPda,
        authority: provider.wallet.publicKey,
        newBotAuthority: provider.wallet.publicKey,
      })
      .rpc();
  }

  async function setTestClockOffset(offsetSeconds: bigint | number): Promise<void> {
    const accountInfo = await connection.getAccountInfo(testClockOffsetPda);
    const offset = toBn(offsetSeconds);
    if (accountInfo === null) {
      await program.methods
        .initializeTestClockOffset(offset)
        .accounts({
          authority: provider.wallet.publicKey,
          state: statePda,
          testClockOffset: testClockOffsetPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      return;
    }

    await program.methods
      .setTestClockOffset(offset)
      .accounts({
        authority: provider.wallet.publicKey,
        state: statePda,
        testClockOffset: testClockOffsetPda,
      })
      .rpc();
  }

  async function upsertMockOraclePriceFeed(
    feedSeed: anchor.BN,
    price: bigint,
    exponent = -8,
    publishTime?: number,
  ): Promise<PublicKey> {
    const feedPda = mockOraclePda(feedSeed);
    const accountInfo = await connection.getAccountInfo(feedPda);
    const effectivePublishTime = publishTime ?? (await getOnchainUnixTimestamp());

    if (accountInfo === null) {
      await program.methods
        .initializeMockOraclePriceFeed(feedSeed, toBn(price), exponent, toBn(effectivePublishTime))
        .accounts({
          authority: provider.wallet.publicKey,
          state: statePda,
          mockOraclePriceFeed: feedPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    } else {
      await program.methods
        .setMockOraclePriceFeed(toBn(price), exponent, toBn(effectivePublishTime))
        .accounts({
          authority: provider.wallet.publicKey,
          state: statePda,
          mockOraclePriceFeed: feedPda,
        })
        .rpc();
    }

    return feedPda;
  }

  async function ensureControllableCollateralType(
    oraclePriceFeed: PublicKey,
  ): Promise<ActiveCollateralType> {
    await ensureCollateralRegistryInitialized();

    let registry = await program.account.collateralRegistry.fetch(collateralRegistryPda);
    let target = registry.collateralTypes.find(
      (entry: any) => entry.isActive === true && !(entry.mint as PublicKey).equals(NATIVE_MINT),
    );
    if (!target) {
      target = registry.collateralTypes.find((entry: any) => entry.isActive === true);
    }

    if (!target) {
      if (registry.collateralTypes.length >= 20) {
        throw new Error("no active collateral type and collateral registry is full");
      }
      const mint = await createMint(connection, payer, provider.wallet.publicKey, null, 8);
      await program.methods
        .addCollateralType(oraclePriceFeed, 8, 500, 11_000)
        .accounts({
          authority: provider.wallet.publicKey,
          state: statePda,
          collateralRegistry: collateralRegistryPda,
          collateralMint: mint,
          oraclePriceFeed,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      registry = await program.account.collateralRegistry.fetch(collateralRegistryPda);
      target = registry.collateralTypes.find((entry: any) => entry.mint.equals(mint));
    } else if (!target.oraclePriceFeed.equals(oraclePriceFeed)) {
      await program.methods
        .updateCollateralType(target.mint, oraclePriceFeed, null, null)
        .accounts({
          authority: provider.wallet.publicKey,
          state: statePda,
          collateralRegistry: collateralRegistryPda,
          oraclePriceFeed,
        })
        .rpc();
      registry = await program.account.collateralRegistry.fetch(collateralRegistryPda);
      target = registry.collateralTypes.find((entry: any) => entry.mint.equals(target.mint));
    }

    return {
      mint: target.mint as PublicKey,
      oraclePriceFeed: target.oraclePriceFeed as PublicKey,
      decimals: target.decimals as number,
      liquidationBufferBps: target.liquidationBufferBps as number,
      minCommittedFloorBps: target.minCommittedFloorBps as number,
    };
  }

  async function ensureCollateralTypeForMint(
    mint: PublicKey,
    oraclePriceFeed: PublicKey,
    decimals: number,
    liquidationBufferBps = 500,
    minCommittedFloorBps = 11_000,
  ): Promise<ActiveCollateralType> {
    await ensureCollateralRegistryInitialized();
    let registry = await program.account.collateralRegistry.fetch(collateralRegistryPda);
    let target = registry.collateralTypes.find((entry: any) => entry.mint.equals(mint));

    if (!target) {
      const hasInactiveEntry = registry.collateralTypes.some((entry: any) => !entry.isActive);
      if (
        registry.collateralTypes.length >= 20 &&
        (!mint.equals(NATIVE_MINT) || !hasInactiveEntry)
      ) {
        throw new Error(`collateral registry full; cannot add mint ${mint.toBase58()}`);
      }
      await program.methods
        .addCollateralType(oraclePriceFeed, decimals, liquidationBufferBps, minCommittedFloorBps)
        .accounts({
          authority: provider.wallet.publicKey,
          state: statePda,
          collateralRegistry: collateralRegistryPda,
          collateralMint: mint,
          oraclePriceFeed,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      registry = await program.account.collateralRegistry.fetch(collateralRegistryPda);
      target = registry.collateralTypes.find((entry: any) => entry.mint.equals(mint));
    } else {
      if (!target.isActive) {
        throw new Error(`collateral type ${mint.toBase58()} is inactive and cannot be reactivated`);
      }
      await program.methods
        .updateCollateralType(
          mint,
          oraclePriceFeed,
          liquidationBufferBps === target.liquidationBufferBps ? null : liquidationBufferBps,
          minCommittedFloorBps === target.minCommittedFloorBps ? null : minCommittedFloorBps,
        )
        .accounts({
          authority: provider.wallet.publicKey,
          state: statePda,
          collateralRegistry: collateralRegistryPda,
          oraclePriceFeed,
        })
        .rpc();
      registry = await program.account.collateralRegistry.fetch(collateralRegistryPda);
      target = registry.collateralTypes.find((entry: any) => entry.mint.equals(mint));
    }

    return {
      mint: target.mint as PublicKey,
      oraclePriceFeed: target.oraclePriceFeed as PublicKey,
      decimals: target.decimals as number,
      liquidationBufferBps: target.liquidationBufferBps as number,
      minCommittedFloorBps: target.minCommittedFloorBps as number,
    };
  }

  async function fundBorrowerCollateralAta(
    borrower: anchor.web3.Keypair,
    mint: PublicKey,
    collateralAta: PublicKey,
    amount: bigint,
  ): Promise<void> {
    if (mint.equals(NATIVE_MINT)) {
      const tx = new anchor.web3.Transaction().add(
        SystemProgram.transfer({
          fromPubkey: borrower.publicKey,
          toPubkey: collateralAta,
          lamports: bigintToSafeNumber(amount),
        }),
        createSyncNativeInstruction(collateralAta),
      );
      await anchor.web3.sendAndConfirmTransaction(connection, tx, [borrower]);
      return;
    }

    await mintTo(
      connection,
      payer,
      mint,
      collateralAta,
      provider.wallet.publicKey,
      amount,
    );
  }

  async function createContractFixture(params: {
    loanType: "demand" | "committed";
    targetAmount: bigint;
    ltvFloorBps: number;
    collateralAmount?: bigint;
    collateralTypeOverride?: ActiveCollateralType;
    oracleFeedSeed: anchor.BN;
    oraclePrice: bigint;
    oraclePublishTime?: number;
    termDays?: number;
    /** Extra headroom for wSOL wrap/unwrap and native rent (default 0.03 SOL). */
    borrowerSolAirdropSol?: number;
    frontendOperatorPda?: PublicKey;
    frontendUsdcAta?: PublicKey;
  }): Promise<ContractFixture> {
    const borrower = anchor.web3.Keypair.generate();
    await airdropSol(connection, borrower, params.borrowerSolAirdropSol ?? 0.03);

    const oraclePriceFeed = await upsertMockOraclePriceFeed(
      params.oracleFeedSeed,
      params.oraclePrice,
      -8,
      params.oraclePublishTime,
    );
    const collateralType =
      params.collateralTypeOverride ??
      (await ensureControllableCollateralType(oraclePriceFeed));
    const usdcMint = await getCanonicalUsdcMint();
    const effectiveFloorBps =
      params.loanType === "demand"
        ? Math.max(params.ltvFloorBps, 10_500)
        : Math.max(params.ltvFloorBps, collateralType.minCommittedFloorBps);
    const targetValueAtCreation =
      (params.targetAmount *
        BigInt(effectiveFloorBps + collateralType.liquidationBufferBps + 500)) /
      10_000n;
    const selectedCollateralAmount =
      params.collateralAmount ??
      computeCollateralAmountForTargetValue(
        targetValueAtCreation,
        collateralType.decimals,
        params.oraclePrice,
        -8,
      );

    const contractSeed = nextContractSeed();
    const [contractPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("debt_contract"), borrower.publicKey.toBuffer(), u64ToLeBytes(contractSeed)],
      program.programId,
    );
    const [operationsFundPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("operations_fund"), contractPda.toBuffer()],
      program.programId,
    );

    const borrowerCollateralAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      collateralType.mint,
      borrower.publicKey,
    );
    const contractCollateralAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      collateralType.mint,
      contractPda,
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
      contractPda,
      true,
    );
    const treasuryUsdcAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      usdcMint,
      treasuryPda,
      true,
    );

    await fundBorrowerCollateralAta(
      borrower,
      collateralType.mint,
      borrowerCollateralAta.address,
      selectedCollateralAmount,
    );
    await mintTo(connection, payer, usdcMint, borrowerUsdcAta.address, provider.wallet.publicKey, 500_000n);

    const createDebtContractAccounts: Record<string, PublicKey | null> = {
      contract: contractPda,
      operationsFund: operationsFundPda,
      state: statePda,
      treasury: treasuryPda,
      borrower: borrower.publicKey,
      systemProgram: SystemProgram.programId,
      collateralRegistry: collateralRegistryPda,
      collateralMint: collateralType.mint,
      borrowerCollateralAta: borrowerCollateralAta.address,
      contractCollateralAta: contractCollateralAta.address,
      priceFeedAccount: collateralType.oraclePriceFeed,
      usdcMint,
      contractUsdcAta: contractUsdcAta.address,
      borrowerUsdcAta: borrowerUsdcAta.address,
      treasuryUsdcAccount: treasuryUsdcAta.address,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      frontendOperator: params.frontendOperatorPda ?? null,
      frontendUsdcAta: params.frontendUsdcAta ?? null,
    };

    await program.methods
      .createDebtContract(
        contractSeed,
        14,
        toBn(params.targetAmount),
        new anchor.BN(500),
        params.termDays ?? 30,
        toBn(selectedCollateralAmount),
        params.loanType === "demand" ? { demand: {} } : { committed: {} },
        new anchor.BN(effectiveFloorBps),
        effectiveFloorBps,
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
      .accounts(createDebtContractAccounts)
      .signers([borrower])
      .rpc();

    return {
      borrower,
      contractSeed,
      oracleFeedSeed: params.oracleFeedSeed,
      contractPda,
      operationsFundPda,
      collateralType,
      collateralAmount: selectedCollateralAmount,
      targetAmount: params.targetAmount,
      ltvFloorBps: effectiveFloorBps,
      loanType: params.loanType,
      usdcMint,
      borrowerCollateralAta: borrowerCollateralAta.address,
      contractCollateralAta: contractCollateralAta.address,
      borrowerUsdcAta: borrowerUsdcAta.address,
      contractUsdcAta: contractUsdcAta.address,
      treasuryUsdcAta: treasuryUsdcAta.address,
    };
  }

  async function contributeToContract(
    fixture: ContractFixture,
    amount: bigint,
  ): Promise<LenderPosition> {
    const lender = anchor.web3.Keypair.generate();
    await airdropSol(connection, lender, 0.02);

    const [contributionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("contribution"), fixture.contractPda.toBuffer(), lender.publicKey.toBuffer()],
      program.programId,
    );
    const [escrowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), fixture.contractPda.toBuffer(), lender.publicKey.toBuffer()],
      program.programId,
    );

    const lenderUsdcAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      fixture.usdcMint,
      lender.publicKey,
    );
    await mintTo(
      connection,
      payer,
      fixture.usdcMint,
      lenderUsdcAta.address,
      provider.wallet.publicKey,
      amount,
    );

    await program.methods
      .contributeToContract(toBn(amount))
      .accountsPartial({
        contract: fixture.contractPda,
        state: statePda,
        contribution: contributionPda,
        escrow: escrowPda,
        lender: lender.publicKey,
        borrower: fixture.borrower.publicKey,
        approvedFunder: null,
        lenderUsdcAccount: lenderUsdcAta.address,
        contractUsdcAccount: fixture.contractUsdcAta,
        borrowerUsdcAccount: fixture.borrowerUsdcAta,
        usdcMint: fixture.usdcMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([lender])
      .rpc();

    const escrowUsdcAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      fixture.usdcMint,
      escrowPda,
      true,
    );

    return {
      lender,
      amount,
      contributionPda,
      escrowPda,
      lenderUsdcAta: lenderUsdcAta.address,
      escrowUsdcAta: escrowUsdcAta.address,
    };
  }

  async function getBotLiquidationAccounts(
    usdcMint: PublicKey,
    collateralMint: PublicKey,
    borrowerCollateralAta: PublicKey,
  ): Promise<{
    botUsdcAta: PublicKey;
    botCollateralAta: PublicKey;
    borrowerCollateralAta: PublicKey;
  }> {
    const botUsdcAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      usdcMint,
      provider.wallet.publicKey,
    );
    const botCollateralAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      collateralMint,
      provider.wallet.publicKey,
    );
    return {
      botUsdcAta: botUsdcAta.address,
      botCollateralAta: botCollateralAta.address,
      borrowerCollateralAta,
    };
  }

  let mockOracleAvailable: boolean;

  before(async () => {
    await ensurePlatformInitialized();
    mockOracleAvailable =
      typeof program.methods.initializeMockOraclePriceFeed === "function" &&
      typeof program.methods.setMockOraclePriceFeed === "function";
  });

  beforeEach(async () => {
    if (!mockOracleAvailable) return;
    const freshPublishTime = new anchor.BN(Math.floor(Date.now() / 1000));
    const registry = await program.account.collateralRegistry.fetch(collateralRegistryPda);
    for (const entry of registry.collateralTypes as Array<{
      isActive: boolean;
      oraclePriceFeed: PublicKey;
    }>) {
      if (!entry.isActive) continue;
      await program.methods
        .setMockOraclePriceFeed(
          toBn(250_000_000_000n),
          -8,
          freshPublishTime,
        )
        .accounts({
          authority: provider.wallet.publicKey,
          state: statePda,
          mockOraclePriceFeed: entry.oraclePriceFeed,
        })
        .rpc();
    }
  });

  it("exposes stream12 support instructions in current IDL", function () {
    const instructionNames = new Set(
      program.idl.instructions.map((ix: { name: string }) => ix.name),
    );
    assert.isTrue(instructionNames.has("createDebtContract"));
    assert.isTrue(instructionNames.has("addCollateral"));
    assert.isTrue(instructionNames.has("partialLiquidate"));
    assert.isTrue(instructionNames.has("requestRecall"));
    assert.isTrue(instructionNames.has("processRecall"));
  });

  it("rejects unauthorized treasury initialization attempts", async () => {
    const attacker = anchor.web3.Keypair.generate();
    await airdropSol(connection, attacker, 0.01);
    const treasuryUsdcMint = await getCanonicalUsdcMint();

    try {
      await program.methods
        .initializeTreasury(provider.wallet.publicKey, treasuryUsdcMint)
        .accounts({
          state: statePda,
          treasury: treasuryPda,
          authority: attacker.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([attacker])
        .rpc();
      assert.fail("expected unauthorized initialize_treasury to fail");
    } catch (error) {
      assert.match(
        parseErrorMessage(error),
        /(InvalidAuthority|AccountNotSigner|already in use|already initialized|not provided)/i,
      );
    }
  });

  it("enforces pause gates on add collateral and recall flows", async function () {
    if (!mockOracleAvailable) return this.skip();
    const fixture = await createContractFixture({
      loanType: "demand",
      targetAmount: 120_000_000n,
      ltvFloorBps: 11_500,
      oracleFeedSeed: nextOracleSeed(),
      oraclePrice: 250_000_000_000n,
    });
    const lender = await contributeToContract(fixture, fixture.targetAmount);

    const topUpAmount = 100_000n;
    await fundBorrowerCollateralAta(
      fixture.borrower,
      fixture.collateralType.mint,
      fixture.borrowerCollateralAta,
      topUpAmount,
    );

    const currentState = await program.account.state.fetch(statePda);
    if (!currentState.isPaused) {
      await program.methods
        .togglePause()
        .accounts({
          state: statePda,
          authority: provider.wallet.publicKey,
        })
        .rpc();
    }

    try {
      try {
        await program.methods
          .addCollateral(toBn(topUpAmount))
          .accounts({
            contract: fixture.contractPda,
            state: statePda,
            borrower: fixture.borrower.publicKey,
            borrowerCollateralAta: fixture.borrowerCollateralAta,
            contractCollateralAta: fixture.contractCollateralAta,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([fixture.borrower])
          .rpc();
        assert.fail("expected add_collateral to fail while paused");
      } catch (error) {
        assert.match(parseErrorMessage(error), /(PlatformPaused|AccountNotSigner)/);
      }

      try {
        await program.methods
          .requestRecall()
          .accounts({
            contract: fixture.contractPda,
            state: statePda,
            lender: lender.lender.publicKey,
            contribution: lender.contributionPda,
          })
          .signers([lender.lender])
          .rpc();
        assert.fail("expected request_recall to fail while paused");
      } catch (error) {
        assert.match(parseErrorMessage(error), /(PlatformPaused|AccountNotSigner)/);
      }
    } finally {
      const state = await program.account.state.fetch(statePda);
      if (state.isPaused) {
        await program.methods
          .togglePause()
          .accounts({
            state: statePda,
            authority: provider.wallet.publicKey,
          })
          .rpc();
      }
    }

    await program.methods
      .requestRecall()
      .accounts({
        contract: fixture.contractPda,
        state: statePda,
        lender: lender.lender.publicKey,
        contribution: lender.contributionPda,
      })
      .signers([lender.lender])
      .rpc();
  });

  it("builds mock oracle payloads that match parser expectations", () => {
    const publishTime = 1_739_000_000;
    const payload = buildMockPythPriceAccountData({
      price: 6_000_000_000_000n,
      exponent: -8,
      publishTime,
      verification: "full",
    });

    let cursor = 0;
    cursor += 8; // discriminator
    cursor += 32; // write authority
    const verification = payload.readUInt8(cursor);
    cursor += 1;
    assert.equal(verification, 1, "verification variant should be Full");

    cursor += 32; // feed id
    const price = payload.readBigInt64LE(cursor);
    cursor += 8;
    cursor += 8; // conf
    const exponent = payload.readInt32LE(cursor);
    cursor += 4;
    const parsedPublishTime = Number(payload.readBigInt64LE(cursor));

    assert.equal(price, 6_000_000_000_000n);
    assert.equal(exponent, -8);
    assert.equal(parsedPublishTime, publishTime);
  });

  it("updates program-owned mock oracle accounts deterministically", async function () {
    if (!mockOracleAvailable) return this.skip();
    const oracleSeed = nextOracleSeed();
    const feed = await upsertMockOraclePriceFeed(oracleSeed, 250_000_000_000n, -8);
    await upsertMockOraclePriceFeed(oracleSeed, 190_000_000_000n, -8);

    const accountNamespace = program.account as unknown as Record<
      string,
      { fetch: (address: PublicKey) => Promise<{ price: anchor.BN; exponent: number }> }
    >;
    const feedAccount = await accountNamespace.mockOraclePriceFeed.fetch(feed);
    const feedInfo = await connection.getAccountInfo(feed);
    assert.isNotNull(feedInfo);
    assert.ok(feedInfo?.owner.equals(program.programId));
    assert.equal(feedAccount.price.toString(), "190000000000");
    assert.equal(feedAccount.exponent, -8);
  });

  it("runs full standard lifecycle with escrow distribution and token claims", async function () {
    if (!mockOracleAvailable) return this.skip();
    const oracleSeed = nextOracleSeed();
    const fixture = await createContractFixture({
      loanType: "committed",
      targetAmount: 100_000_000n,
      ltvFloorBps: 11_000,
      oracleFeedSeed: oracleSeed,
      oraclePrice: 250_000_000_000n,
    });

    const borrowerUsdcBeforeContributions = await getAccount(connection, fixture.borrowerUsdcAta);
    const lenderA = await contributeToContract(fixture, 60_000_000n);
    const lenderB = await contributeToContract(fixture, 40_000_000n);

    const contractAfterFunding = await program.account.debtContract.fetch(fixture.contractPda);
    expectAnchorEnumVariant(contractAfterFunding.status, "active");
    assert.equal(contractAfterFunding.contractVersion, 2);

    const borrowerUsdcAfterFunding = await getAccount(connection, fixture.borrowerUsdcAta);
    assert.equal(
      (borrowerUsdcAfterFunding.amount - borrowerUsdcBeforeContributions.amount).toString(),
      fixture.targetAmount.toString(),
      "borrower should receive funded USDC amount when contract activates",
    );

    await program.methods
      .makePaymentWithDistribution(toBn(fixture.targetAmount))
      .accounts({
        contract: fixture.contractPda,
        operationsFund: fixture.operationsFundPda,
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
        { pubkey: lenderA.contributionPda, isSigner: false, isWritable: false },
        { pubkey: lenderA.escrowPda, isSigner: false, isWritable: true },
        { pubkey: lenderA.escrowUsdcAta, isSigner: false, isWritable: true },
        { pubkey: lenderB.contributionPda, isSigner: false, isWritable: false },
        { pubkey: lenderB.escrowPda, isSigner: false, isWritable: true },
        { pubkey: lenderB.escrowUsdcAta, isSigner: false, isWritable: true },
      ])
      .signers([fixture.borrower])
      .rpc();

    const lenderABalanceBeforeClaim = await getAccount(connection, lenderA.lenderUsdcAta);
    const lenderBBalanceBeforeClaim = await getAccount(connection, lenderB.lenderUsdcAta);

    await program.methods
      .claimFromEscrow()
      .accounts({
        contract: fixture.contractPda,
        escrow: lenderA.escrowPda,
        lender: lenderA.lender.publicKey,
        escrowUsdcAccount: lenderA.escrowUsdcAta,
        lenderUsdcAccount: lenderA.lenderUsdcAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([lenderA.lender])
      .rpc();

    await program.methods
      .claimFromEscrow()
      .accounts({
        contract: fixture.contractPda,
        escrow: lenderB.escrowPda,
        lender: lenderB.lender.publicKey,
        escrowUsdcAccount: lenderB.escrowUsdcAta,
        lenderUsdcAccount: lenderB.lenderUsdcAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([lenderB.lender])
      .rpc();

    const lenderABalanceAfterClaim = await getAccount(connection, lenderA.lenderUsdcAta);
    const lenderBBalanceAfterClaim = await getAccount(connection, lenderB.lenderUsdcAta);
    assert.isAbove(
      Number(lenderABalanceAfterClaim.amount - lenderABalanceBeforeClaim.amount),
      0,
      "lender A should receive distributed principal/interest",
    );
    assert.isAbove(
      Number(lenderBBalanceAfterClaim.amount - lenderBBalanceBeforeClaim.amount),
      0,
      "lender B should receive distributed principal/interest",
    );

    const contractAfter = await program.account.debtContract.fetch(fixture.contractPda);
    const contractCollateralBalance = await getAccount(connection, fixture.contractCollateralAta);
    expectAnchorEnumVariant(contractAfter.status, "completed");
    assert.equal(contractAfter.outstandingBalance.toNumber(), 0);
    assert.equal(contractCollateralBalance.amount.toString(), "0");
  });

  it("rejects unauthorized callers for makePaymentWithDistribution, claimFromEscrow, and cancelContract", async function () {
    if (!mockOracleAvailable) return this.skip();
    const fixture = await createContractFixture({
      loanType: "committed",
      targetAmount: 100_000_000n,
      ltvFloorBps: 11_000,
      oracleFeedSeed: nextOracleSeed(),
      oraclePrice: 250_000_000_000n,
    });
    const lender = await contributeToContract(fixture, fixture.targetAmount);
    const attacker = anchor.web3.Keypair.generate();
    await airdropSol(connection, attacker, 0.01);
    const attackerUsdcAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      fixture.usdcMint,
      attacker.publicKey,
    );
    await mintTo(
      connection,
      payer,
      fixture.usdcMint,
      attackerUsdcAta.address,
      provider.wallet.publicKey,
      fixture.targetAmount,
    );

    try {
      await program.methods
        .makePaymentWithDistribution(toBn(10_000_000n))
        .accounts({
          contract: fixture.contractPda,
          operationsFund: fixture.operationsFundPda,
          state: statePda,
          borrower: attacker.publicKey,
          borrowerUsdcAccount: attackerUsdcAta.address,
          contractUsdcAccount: fixture.contractUsdcAta,
          contractCollateralAccount: fixture.contractCollateralAta,
          borrowerCollateralAccount: fixture.borrowerCollateralAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts([
          { pubkey: lender.contributionPda, isSigner: false, isWritable: false },
          { pubkey: lender.escrowPda, isSigner: false, isWritable: true },
          { pubkey: lender.escrowUsdcAta, isSigner: false, isWritable: true },
        ])
        .signers([attacker])
        .rpc();
      assert.fail("expected non-borrower make_payment_with_distribution to fail");
    } catch (error) {
      assert.match(parseErrorMessage(error), /UnauthorizedPayment/);
    }

    try {
      await program.methods
        .claimFromEscrow()
        .accounts({
          contract: fixture.contractPda,
          escrow: lender.escrowPda,
          lender: attacker.publicKey,
          escrowUsdcAccount: lender.escrowUsdcAta,
          lenderUsdcAccount: attackerUsdcAta.address,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([attacker])
        .rpc();
      assert.fail("expected non-lender claim_from_escrow to fail");
    } catch (error) {
      assert.match(parseErrorMessage(error), /(UnauthorizedClaim|ConstraintSeeds|A seeds constraint was violated)/);
    }

    try {
      await program.methods
        .cancelContract()
        .accounts({
          contract: fixture.contractPda,
          operationsFund: fixture.operationsFundPda,
          borrower: attacker.publicKey,
          contractCollateralAta: fixture.contractCollateralAta,
          borrowerCollateralAta: fixture.borrowerCollateralAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([attacker])
        .rpc();
      assert.fail("expected non-borrower cancel_contract to fail");
    } catch (error) {
      assert.match(parseErrorMessage(error), /UnauthorizedCancellation/);
    }
  });

  it("rejects zero-amount contributions and self-funding contributions", async function () {
    if (!mockOracleAvailable) return this.skip();
    const fixture = await createContractFixture({
      loanType: "committed",
      targetAmount: 80_000_000n,
      ltvFloorBps: 11_000,
      oracleFeedSeed: nextOracleSeed(),
      oraclePrice: 250_000_000_000n,
    });

    try {
      await contributeToContract(fixture, 0n);
      assert.fail("expected zero contribution amount to fail");
    } catch (error) {
      assert.match(parseErrorMessage(error), /InvalidContributionAmount/);
    }

    const [selfContributionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("contribution"), fixture.contractPda.toBuffer(), fixture.borrower.publicKey.toBuffer()],
      program.programId,
    );
    const [selfEscrowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), fixture.contractPda.toBuffer(), fixture.borrower.publicKey.toBuffer()],
      program.programId,
    );
    try {
      await program.methods
        .contributeToContract(toBn(1_000_000n))
        .accountsPartial({
          contract: fixture.contractPda,
          state: statePda,
          contribution: selfContributionPda,
          escrow: selfEscrowPda,
          lender: fixture.borrower.publicKey,
          borrower: fixture.borrower.publicKey,
          approvedFunder: null,
          lenderUsdcAccount: fixture.borrowerUsdcAta,
          contractUsdcAccount: fixture.contractUsdcAta,
          borrowerUsdcAccount: fixture.borrowerUsdcAta,
          usdcMint: fixture.usdcMint,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([fixture.borrower])
        .rpc();
      assert.fail("expected borrower self-funding to fail");
    } catch (error) {
      assert.match(parseErrorMessage(error), /SelfFundingNotAllowed/);
    }
  });

  it("rejects unapproved collateral and oracle mismatch on contract creation", async function () {
    if (!mockOracleAvailable) return this.skip();
    const oracleSeedA = nextOracleSeed();
    const oracleSeedB = nextOracleSeed();
    const oracleA = await upsertMockOraclePriceFeed(oracleSeedA, 250_000_000_000n, -8);
    const oracleB = await upsertMockOraclePriceFeed(oracleSeedB, 250_000_000_000n, -8);
    const approved = await ensureControllableCollateralType(oracleA);

    const borrower = anchor.web3.Keypair.generate();
    await airdropSol(connection, borrower, 0.03);
    const usdcMint = await getCanonicalUsdcMint();
    const unapprovedMint = await createMint(connection, payer, provider.wallet.publicKey, null, 8);

    const contractSeedA = nextContractSeed();
    const [contractPdaA] = PublicKey.findProgramAddressSync(
      [Buffer.from("debt_contract"), borrower.publicKey.toBuffer(), u64ToLeBytes(contractSeedA)],
      program.programId,
    );
    const [operationsFundPdaA] = PublicKey.findProgramAddressSync(
      [Buffer.from("operations_fund"), contractPdaA.toBuffer()],
      program.programId,
    );

    const borrowerUnapprovedAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      unapprovedMint,
      borrower.publicKey,
    );
    const contractUnapprovedAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      unapprovedMint,
      contractPdaA,
      true,
    );
    const contractUsdcAtaA = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      usdcMint,
      contractPdaA,
      true,
    );
    const borrowerUsdcAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      usdcMint,
      borrower.publicKey,
    );
    const treasuryUsdcAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      usdcMint,
      treasuryPda,
      true,
    );
    await mintTo(
      connection,
      payer,
      unapprovedMint,
      borrowerUnapprovedAta.address,
      provider.wallet.publicKey,
      10n ** 8n,
    );
    await mintTo(
      connection,
      payer,
      usdcMint,
      borrowerUsdcAta.address,
      provider.wallet.publicKey,
      200_000_000n,
    );

    try {
      await program.methods
        .createDebtContract(
          contractSeedA,
          14,
          toBn(100_000_000n),
          new anchor.BN(500),
          30,
          toBn(10n ** 8n),
          { committed: {} },
          new anchor.BN(11_000),
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
          contract: contractPdaA,
          operationsFund: operationsFundPdaA,
          state: statePda,
          treasury: treasuryPda,
          borrower: borrower.publicKey,
          systemProgram: SystemProgram.programId,
          collateralRegistry: collateralRegistryPda,
          collateralMint: unapprovedMint,
          borrowerCollateralAta: borrowerUnapprovedAta.address,
          contractCollateralAta: contractUnapprovedAta.address,
          priceFeedAccount: oracleA,
          usdcMint,
          contractUsdcAta: contractUsdcAtaA.address,
          borrowerUsdcAta: borrowerUsdcAta.address,
          treasuryUsdcAccount: treasuryUsdcAta.address,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        })
        .signers([borrower])
        .rpc();
      assert.fail("expected unapproved collateral mint to be rejected");
    } catch (error) {
      assert.match(parseErrorMessage(error), /CollateralTypeNotApproved/);
    }

    const contractSeedB = nextContractSeed();
    const [contractPdaB] = PublicKey.findProgramAddressSync(
      [Buffer.from("debt_contract"), borrower.publicKey.toBuffer(), u64ToLeBytes(contractSeedB)],
      program.programId,
    );
    const [operationsFundPdaB] = PublicKey.findProgramAddressSync(
      [Buffer.from("operations_fund"), contractPdaB.toBuffer()],
      program.programId,
    );
    const borrowerApprovedAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      approved.mint,
      borrower.publicKey,
    );
    const contractApprovedAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      approved.mint,
      contractPdaB,
      true,
    );
    const contractUsdcAtaB = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      usdcMint,
      contractPdaB,
      true,
    );
    await mintTo(
      connection,
      payer,
      approved.mint,
      borrowerApprovedAta.address,
      provider.wallet.publicKey,
      10n ** BigInt(approved.decimals),
    );

    try {
      await program.methods
        .createDebtContract(
          contractSeedB,
          14,
          toBn(100_000_000n),
          new anchor.BN(500),
          30,
          toBn(10n ** BigInt(approved.decimals)),
          { committed: {} },
          new anchor.BN(11_000),
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
          contract: contractPdaB,
          operationsFund: operationsFundPdaB,
          state: statePda,
          treasury: treasuryPda,
          borrower: borrower.publicKey,
          systemProgram: SystemProgram.programId,
          collateralRegistry: collateralRegistryPda,
          collateralMint: approved.mint,
          borrowerCollateralAta: borrowerApprovedAta.address,
          contractCollateralAta: contractApprovedAta.address,
          priceFeedAccount: oracleB,
          usdcMint,
          contractUsdcAta: contractUsdcAtaB.address,
          borrowerUsdcAta: borrowerUsdcAta.address,
          treasuryUsdcAccount: treasuryUsdcAta.address,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        })
        .signers([borrower])
        .rpc();
      assert.fail("expected oracle mismatch to be rejected");
    } catch (error) {
      assert.match(parseErrorMessage(error), /OraclePriceFeedMismatch/);
    }
  });

  it("enforces stale oracle and LTV floor boundaries", async function () {
    if (!mockOracleAvailable) return this.skip();
    const staleOracleSeed = nextOracleSeed();
    const stalePublishTime = Math.floor(Date.now() / 1000) - (MAX_PRICE_AGE_CREATION_SECONDS + 10);
    const staleOracle = await upsertMockOraclePriceFeed(
      staleOracleSeed,
      250_000_000_000n,
      -8,
      stalePublishTime,
    );
    const collateralType = await ensureControllableCollateralType(staleOracle);

    const borrower = anchor.web3.Keypair.generate();
    await airdropSol(connection, borrower, 0.03);
    const usdcMint = await getCanonicalUsdcMint();

    const contractSeed = nextContractSeed();
    const [contractPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("debt_contract"), borrower.publicKey.toBuffer(), u64ToLeBytes(contractSeed)],
      program.programId,
    );
    const [operationsFundPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("operations_fund"), contractPda.toBuffer()],
      program.programId,
    );
    const collateralAmount = 10n ** BigInt(collateralType.decimals);
    const borrowerCollateralAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      collateralType.mint,
      borrower.publicKey,
    );
    const contractCollateralAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      collateralType.mint,
      contractPda,
      true,
    );
    const contractUsdcAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      usdcMint,
      contractPda,
      true,
    );
    const borrowerUsdcAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      usdcMint,
      borrower.publicKey,
    );
    const treasuryUsdcAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      usdcMint,
      treasuryPda,
      true,
    );
    await mintTo(
      connection,
      payer,
      collateralType.mint,
      borrowerCollateralAta.address,
      provider.wallet.publicKey,
      collateralAmount,
    );
    await mintTo(
      connection,
      payer,
      usdcMint,
      borrowerUsdcAta.address,
      provider.wallet.publicKey,
      200_000_000n,
    );

    try {
      await program.methods
        .createDebtContract(
          contractSeed,
          14,
          toBn(100_000_000n),
          new anchor.BN(500),
          30,
          toBn(collateralAmount),
          { committed: {} },
          new anchor.BN(Math.max(collateralType.minCommittedFloorBps, 11_000)),
          Math.max(collateralType.minCommittedFloorBps, 11_000),
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
          contract: contractPda,
          operationsFund: operationsFundPda,
          state: statePda,
          treasury: treasuryPda,
          borrower: borrower.publicKey,
          systemProgram: SystemProgram.programId,
          collateralRegistry: collateralRegistryPda,
          collateralMint: collateralType.mint,
          borrowerCollateralAta: borrowerCollateralAta.address,
          contractCollateralAta: contractCollateralAta.address,
          priceFeedAccount: staleOracle,
          usdcMint,
          contractUsdcAta: contractUsdcAta.address,
          borrowerUsdcAta: borrowerUsdcAta.address,
          treasuryUsdcAccount: treasuryUsdcAta.address,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        })
        .signers([borrower])
        .rpc();
      assert.fail("expected stale oracle to be rejected");
    } catch (error) {
      assert.match(parseErrorMessage(error), /OraclePriceStale/);
    }

    const freshOracleSeed = nextOracleSeed();
    const freshOracle = await upsertMockOraclePriceFeed(freshOracleSeed, 250_000_000_000n, -8);
    const activeType = await ensureControllableCollateralType(freshOracle);

    const floorBorrower = anchor.web3.Keypair.generate();
    await airdropSol(connection, floorBorrower, 0.03);
    const floorUsdcMint = await getCanonicalUsdcMint();
    const floorSeed = nextContractSeed();
    const [floorContractPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("debt_contract"), floorBorrower.publicKey.toBuffer(), u64ToLeBytes(floorSeed)],
      program.programId,
    );
    const [floorOperationsPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("operations_fund"), floorContractPda.toBuffer()],
      program.programId,
    );
    const floorBorrowerAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      activeType.mint,
      floorBorrower.publicKey,
    );
    const floorContractAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      activeType.mint,
      floorContractPda,
      true,
    );
    const floorContractUsdcAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      floorUsdcMint,
      floorContractPda,
      true,
    );
    const floorBorrowerUsdcAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      floorUsdcMint,
      floorBorrower.publicKey,
    );
    const floorTreasuryUsdcAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      floorUsdcMint,
      treasuryPda,
      true,
    );
    await mintTo(
      connection,
      payer,
      activeType.mint,
      floorBorrowerAta.address,
      provider.wallet.publicKey,
      10n ** BigInt(activeType.decimals),
    );
    await mintTo(
      connection,
      payer,
      floorUsdcMint,
      floorBorrowerUsdcAta.address,
      provider.wallet.publicKey,
      200_000_000n,
    );

    try {
      await program.methods
        .createDebtContract(
          floorSeed,
          14,
          toBn(100_000_000n),
          new anchor.BN(500),
          30,
          toBn(10n ** BigInt(activeType.decimals)),
          { demand: {} },
          new anchor.BN(10_000),
          10_000,
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
          contract: floorContractPda,
          operationsFund: floorOperationsPda,
          state: statePda,
          treasury: treasuryPda,
          borrower: floorBorrower.publicKey,
          systemProgram: SystemProgram.programId,
          collateralRegistry: collateralRegistryPda,
          collateralMint: activeType.mint,
          borrowerCollateralAta: floorBorrowerAta.address,
          contractCollateralAta: floorContractAta.address,
          priceFeedAccount: freshOracle,
          usdcMint: floorUsdcMint,
          contractUsdcAta: floorContractUsdcAta.address,
          borrowerUsdcAta: floorBorrowerUsdcAta.address,
          treasuryUsdcAccount: floorTreasuryUsdcAta.address,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        })
        .signers([floorBorrower])
        .rpc();
      assert.fail("expected demand floor under minimum to fail");
    } catch (error) {
      assert.match(parseErrorMessage(error), /DemandLoanFloorTooLow/);
    }
  });

  it("enforces committed-loan floor minimum for collateral type", async function () {
    if (!mockOracleAvailable) return this.skip();
    const oracleSeed = nextOracleSeed();
    const oracleFeed = await upsertMockOraclePriceFeed(oracleSeed, 250_000_000_000n, -8);
    const collateralType = await ensureControllableCollateralType(oracleFeed);
    const borrower = anchor.web3.Keypair.generate();
    await airdropSol(connection, borrower, 0.03);

    const targetAmount = 120_000_000n;
    const usdcMint = await getCanonicalUsdcMint();
    const floorBelowMinimum = Math.max(1, collateralType.minCommittedFloorBps - 1);
    const collateralAmount = computeCollateralAmountForTargetValue(
      (targetAmount *
        BigInt(collateralType.minCommittedFloorBps + collateralType.liquidationBufferBps + 500)) /
        10_000n,
      collateralType.decimals,
      250_000_000_000n,
      -8,
    );

    const contractSeed = nextContractSeed();
    const [contractPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("debt_contract"), borrower.publicKey.toBuffer(), u64ToLeBytes(contractSeed)],
      program.programId,
    );
    const [operationsFundPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("operations_fund"), contractPda.toBuffer()],
      program.programId,
    );
    const borrowerCollateralAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      collateralType.mint,
      borrower.publicKey,
    );
    const contractCollateralAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      collateralType.mint,
      contractPda,
      true,
    );
    const contractUsdcAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      usdcMint,
      contractPda,
      true,
    );
    const borrowerUsdcAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      usdcMint,
      borrower.publicKey,
    );
    const treasuryUsdcAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      usdcMint,
      treasuryPda,
      true,
    );

    await fundBorrowerCollateralAta(
      borrower,
      collateralType.mint,
      borrowerCollateralAta.address,
      collateralAmount,
    );
    await mintTo(
      connection,
      payer,
      usdcMint,
      borrowerUsdcAta.address,
      provider.wallet.publicKey,
      200_000_000n,
    );

    try {
      await program.methods
        .createDebtContract(
          contractSeed,
          14,
          toBn(targetAmount),
          new anchor.BN(500),
          45,
          toBn(collateralAmount),
          { committed: {} },
          new anchor.BN(floorBelowMinimum),
          floorBelowMinimum,
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
          contract: contractPda,
          operationsFund: operationsFundPda,
          state: statePda,
          treasury: treasuryPda,
          borrower: borrower.publicKey,
          systemProgram: SystemProgram.programId,
          collateralRegistry: collateralRegistryPda,
          collateralMint: collateralType.mint,
          borrowerCollateralAta: borrowerCollateralAta.address,
          contractCollateralAta: contractCollateralAta.address,
          priceFeedAccount: oracleFeed,
          usdcMint,
          contractUsdcAta: contractUsdcAta.address,
          borrowerUsdcAta: borrowerUsdcAta.address,
          treasuryUsdcAccount: treasuryUsdcAta.address,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        })
        .signers([borrower])
        .rpc();
      assert.fail("expected committed floor below minimum to fail");
    } catch (error) {
      assert.match(parseErrorMessage(error), /LtvFloorBelowMinimum/);
    }
  });

  it("supports collateral top-up and rejects invalid top-ups", async function () {
    if (!mockOracleAvailable) return this.skip();
    const fixture = await createContractFixture({
      loanType: "committed",
      targetAmount: 80_000_000n,
      ltvFloorBps: 11_000,
      oracleFeedSeed: nextOracleSeed(),
      oraclePrice: 250_000_000_000n,
    });
    await contributeToContract(fixture, fixture.targetAmount);

    const topUpAmount = 200_000n;
    await mintTo(
      connection,
      payer,
      fixture.collateralType.mint,
      fixture.borrowerCollateralAta,
      provider.wallet.publicKey,
      topUpAmount,
    );

    const before = await program.account.debtContract.fetch(fixture.contractPda);
    await program.methods
      .addCollateral(toBn(topUpAmount))
      .accounts({
        contract: fixture.contractPda,
        state: statePda,
        borrower: fixture.borrower.publicKey,
        borrowerCollateralAta: fixture.borrowerCollateralAta,
        contractCollateralAta: fixture.contractCollateralAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([fixture.borrower])
      .rpc();
    const after = await program.account.debtContract.fetch(fixture.contractPda);
    const beforeCollateral = BigInt(before.collateralAmount.toString());
    const afterCollateral = BigInt(after.collateralAmount.toString());
    const beforeOutstanding = BigInt(before.outstandingBalance.toString());
    const afterOutstanding = BigInt(after.outstandingBalance.toString());
    assert.equal(
      afterOutstanding.toString(),
      beforeOutstanding.toString(),
      "top-up should not alter outstanding debt",
    );
    assert.equal(
      after.collateralAmount.toString(),
      before.collateralAmount.add(toBn(topUpAmount)).toString(),
    );
    const beforeCollateralPerDebt = (beforeCollateral * 1_000_000n) / beforeOutstanding;
    const afterCollateralPerDebt = (afterCollateral * 1_000_000n) / afterOutstanding;
    assert.isTrue(
      afterCollateralPerDebt > beforeCollateralPerDebt,
      "top-up should improve collateralization ratio versus outstanding debt",
    );

    const attacker = anchor.web3.Keypair.generate();
    await airdropSol(connection, attacker, 0.01);
    try {
      await program.methods
        .addCollateral(toBn(1_000))
        .accounts({
          contract: fixture.contractPda,
          state: statePda,
          borrower: attacker.publicKey,
          borrowerCollateralAta: fixture.borrowerCollateralAta,
          contractCollateralAta: fixture.contractCollateralAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([attacker])
        .rpc();
      assert.fail("expected non-borrower top-up to fail");
    } catch (error) {
      assert.match(parseErrorMessage(error), /UnauthorizedPayment/);
    }

    const wrongMint = await createMint(connection, payer, provider.wallet.publicKey, null, 8);
    const wrongBorrowerAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      wrongMint,
      fixture.borrower.publicKey,
    );
    await mintTo(
      connection,
      payer,
      wrongMint,
      wrongBorrowerAta.address,
      provider.wallet.publicKey,
      10_000n,
    );

    try {
      await program.methods
        .addCollateral(toBn(1_000))
        .accounts({
          contract: fixture.contractPda,
          state: statePda,
          borrower: fixture.borrower.publicKey,
          borrowerCollateralAta: wrongBorrowerAta.address,
          contractCollateralAta: fixture.contractCollateralAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([fixture.borrower])
        .rpc();
      assert.fail("expected wrong-mint top-up to fail");
    } catch (error) {
      assert.match(parseErrorMessage(error), /TokenAccountMismatch/);
    }

    try {
      await program.methods
        .addCollateral(new anchor.BN(0))
        .accounts({
          contract: fixture.contractPda,
          state: statePda,
          borrower: fixture.borrower.publicKey,
          borrowerCollateralAta: fixture.borrowerCollateralAta,
          contractCollateralAta: fixture.contractCollateralAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([fixture.borrower])
        .rpc();
      assert.fail("expected zero top-up to fail");
    } catch (error) {
      assert.match(parseErrorMessage(error), /InvalidPaymentAmount/);
    }
  });

  it("allows top-up during pending recall and rejects top-up on v1 contracts", async function () {
    if (!mockOracleAvailable) return this.skip();
    const fixture = await createContractFixture({
      loanType: "demand",
      targetAmount: 200_000_000n,
      ltvFloorBps: 11_000,
      oracleFeedSeed: nextOracleSeed(),
      oraclePrice: 250_000_000_000n,
    });
    const lender = await contributeToContract(fixture, fixture.targetAmount);

    await program.methods
      .requestRecall()
      .accounts({
        contract: fixture.contractPda,
        state: statePda,
        lender: lender.lender.publicKey,
        contribution: lender.contributionPda,
      })
      .signers([lender.lender])
      .rpc();

    const topUpAmount = 100_000n;
    await fundBorrowerCollateralAta(
      fixture.borrower,
      fixture.collateralType.mint,
      fixture.borrowerCollateralAta,
      topUpAmount,
    );
    const beforeTopUp = await program.account.debtContract.fetch(fixture.contractPda);
    await program.methods
      .addCollateral(toBn(topUpAmount))
      .accounts({
        contract: fixture.contractPda,
        state: statePda,
        borrower: fixture.borrower.publicKey,
        borrowerCollateralAta: fixture.borrowerCollateralAta,
        contractCollateralAta: fixture.contractCollateralAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([fixture.borrower])
      .rpc();
    const afterTopUp = await program.account.debtContract.fetch(fixture.contractPda);
    assert.equal(
      afterTopUp.collateralAmount.toString(),
      beforeTopUp.collateralAmount.add(toBn(topUpAmount)).toString(),
    );

    const v1Borrower = anchor.web3.Keypair.generate();
    await airdropSol(connection, v1Borrower, 0.03);
    const v1Seed = nextContractSeed();
    const [v1ContractPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("debt_contract"), v1Borrower.publicKey.toBuffer(), u64ToLeBytes(v1Seed)],
      program.programId,
    );
    const [v1OperationsFundPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("operations_fund"), v1ContractPda.toBuffer()],
      program.programId,
    );

    try {
      await program.methods
        .createDebtContract(
          v1Seed,
          14,
          new anchor.BN(50_000_000),
          new anchor.BN(500),
          30,
          new anchor.BN(30_000_000),
          { committed: {} },
          new anchor.BN(8_000),
          8_000,
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
          contract: v1ContractPda,
          operationsFund: v1OperationsFundPda,
          state: statePda,
          treasury: treasuryPda,
          borrower: v1Borrower.publicKey,
          systemProgram: SystemProgram.programId,
          collateralRegistry: null,
          collateralMint: null,
          borrowerCollateralAta: null,
          contractCollateralAta: null,
          priceFeedAccount: null,
          usdcMint: null,
          contractUsdcAta: null,
          borrowerUsdcAta: null,
          treasuryUsdcAccount: null,
          tokenProgram: null,
          associatedTokenProgram: null,
        })
        .signers([v1Borrower])
        .rpc();
      assert.fail("expected v1 contract creation with null accounts to fail");
    } catch (error) {
      assert.match(
        parseErrorMessage(error),
        /MissingTokenAccounts|Account `contract` not provided\./,
      );
    }
  });

  it("supports wSOL collateral top-up and unwrap on completion", async function () {
    if (!mockOracleAvailable) return this.skip();
    const oracleFeedSeed = nextOracleSeed();
    const oraclePrice = 250_000_000_000n;
    const oracleFeed = await upsertMockOraclePriceFeed(oracleFeedSeed, oraclePrice, -8);
    const wsolCollateralType = await ensureCollateralTypeForMint(
      NATIVE_MINT,
      oracleFeed,
      9,
      500,
      11_000,
    );

    const fixture = await createContractFixture({
      loanType: "committed",
      targetAmount: 250_000_000n,
      ltvFloorBps: 11_000,
      oracleFeedSeed,
      oraclePrice,
      collateralTypeOverride: wsolCollateralType,
      borrowerSolAirdropSol: 0.3,
    });
    const lender = await contributeToContract(fixture, fixture.targetAmount);

    const topUpAmount = 40_000_000n;
    await fundBorrowerCollateralAta(
      fixture.borrower,
      fixture.collateralType.mint,
      fixture.borrowerCollateralAta,
      topUpAmount,
    );
    await program.methods
      .addCollateral(toBn(topUpAmount))
      .accounts({
        contract: fixture.contractPda,
        state: statePda,
        borrower: fixture.borrower.publicKey,
        borrowerCollateralAta: fixture.borrowerCollateralAta,
        contractCollateralAta: fixture.contractCollateralAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([fixture.borrower])
      .rpc();

    const contractBeforePayment = await program.account.debtContract.fetch(fixture.contractPda);
    const collateralToReturn = BigInt(contractBeforePayment.collateralAmount.toString());
    const borrowerLamportsBefore = BigInt(await connection.getBalance(fixture.borrower.publicKey));
    const fullRepay = BigInt(contractBeforePayment.outstandingBalance.toString()) + BigInt(contractBeforePayment.accruedInterest.toString()) + 1_000n;
    await program.methods
      .makePaymentWithDistribution(toBn(fullRepay))
      .accounts({
        contract: fixture.contractPda,
        operationsFund: fixture.operationsFundPda,
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
        { pubkey: lender.contributionPda, isSigner: false, isWritable: false },
        { pubkey: lender.escrowPda, isSigner: false, isWritable: true },
        { pubkey: lender.escrowUsdcAta, isSigner: false, isWritable: true },
      ])
      .signers([fixture.borrower])
      .rpc();
    const borrowerLamportsAfter = BigInt(await connection.getBalance(fixture.borrower.publicKey));

    const contractAfter = await program.account.debtContract.fetch(fixture.contractPda);
    const contractCollateralInfo = await connection.getAccountInfo(fixture.contractCollateralAta);
    expectAnchorEnumVariant(contractAfter.status, "completed");
    assert.isNull(contractCollateralInfo, "wSOL contract collateral ATA should close and unwrap");
    assert.isTrue(
      borrowerLamportsAfter + 30_000n >= borrowerLamportsBefore + collateralToReturn,
      "borrower should receive native SOL back from unwrapped wSOL collateral",
    );
  });

  it("supports full liquidation seizure for wSOL collateral", async function () {
    if (!mockOracleAvailable) return this.skip();
    const oracleFeedSeed = nextOracleSeed();
    const oraclePrice = 250_000_000_000n;
    const oracleFeed = await upsertMockOraclePriceFeed(oracleFeedSeed, oraclePrice, -8);
    const wsolCollateralType = await ensureCollateralTypeForMint(
      NATIVE_MINT,
      oracleFeed,
      9,
      500,
      11_000,
    );
    const fixture = await createContractFixture({
      loanType: "committed",
      targetAmount: 350_000_000n,
      ltvFloorBps: 11_000,
      oracleFeedSeed,
      oraclePrice,
      collateralTypeOverride: wsolCollateralType,
      borrowerSolAirdropSol: 0.3,
    });
    const lender = await contributeToContract(fixture, fixture.targetAmount);
    const { botUsdcAta, botCollateralAta, borrowerCollateralAta } = await getBotLiquidationAccounts(
      fixture.usdcMint,
      fixture.collateralType.mint,
      fixture.borrowerCollateralAta,
    );
    await mintTo(
      connection,
      payer,
      fixture.usdcMint,
      botUsdcAta,
      provider.wallet.publicKey,
      fixture.targetAmount,
    );

    const triggerPrice = computeThresholdPrice(
      fixture.collateralAmount,
      fixture.collateralType.decimals,
      fixture.targetAmount,
      fixture.ltvFloorBps,
    );
    await upsertMockOraclePriceFeed(fixture.oracleFeedSeed, triggerPrice - 1n, -8);
    await program.methods
      .liquidateContract()
      .accounts({
        contract: fixture.contractPda,
        operationsFund: fixture.operationsFundPda,
        state: statePda,
        testClockOffset: null,
        borrower: fixture.borrower.publicKey,
        liquidator: provider.wallet.publicKey,
        systemProgram: SystemProgram.programId,
        collateralRegistry: collateralRegistryPda,
        priceFeedAccount: fixture.collateralType.oraclePriceFeed,
        treasury: treasuryPda,
        botUsdcAta,
        contractUsdcAta: fixture.contractUsdcAta,
        contractCollateralAta: fixture.contractCollateralAta,
        botCollateralAta,
        borrowerCollateralAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .remainingAccounts([
        { pubkey: lender.contributionPda, isSigner: false, isWritable: false },
        { pubkey: lender.escrowPda, isSigner: false, isWritable: true },
        { pubkey: lender.escrowUsdcAta, isSigner: false, isWritable: true },
      ])
      .rpc();

    const botCollateral = await getAccount(connection, botCollateralAta);
    const contractCollateralInfo = await connection.getAccountInfo(fixture.contractCollateralAta);
    assert.isTrue(botCollateral.amount > 0n, "bot should receive seized wSOL collateral");
    assert.isNull(contractCollateralInfo, "contract wSOL ATA should be closed after liquidation");
  });

  it("enforces partial liquidation health checks and 50% cap", async function () {
    if (!mockOracleAvailable) return this.skip();
    const fixture = await createContractFixture({
      loanType: "committed",
      targetAmount: 1_000_000_000n,
      ltvFloorBps: 11_000,
      oracleFeedSeed: nextOracleSeed(),
      oraclePrice: 250_000_000_000n,
    });
    const lender = await contributeToContract(fixture, fixture.targetAmount);

    const botUsdcAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      fixture.usdcMint,
      provider.wallet.publicKey,
    );
    const botCollateralAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      fixture.collateralType.mint,
      provider.wallet.publicKey,
    );
    const requestedRepay = 700_000_000n;
    await mintTo(
      connection,
      payer,
      fixture.usdcMint,
      botUsdcAta.address,
      provider.wallet.publicKey,
      requestedRepay,
    );

    try {
      const unauthorized = anchor.web3.Keypair.generate();
      await airdropSol(connection, unauthorized, 0.01);
      await program.methods
        .partialLiquidate(toBn(100_000_000n))
        .accounts({
          contract: fixture.contractPda,
          state: statePda,
          collateralRegistry: collateralRegistryPda,
          priceFeedAccount: fixture.collateralType.oraclePriceFeed,
          botUsdcAta: botUsdcAta.address,
          contractUsdcAta: fixture.contractUsdcAta,
          contractCollateralAta: fixture.contractCollateralAta,
          botCollateralAta: botCollateralAta.address,
          treasury: treasuryPda,
          botAuthority: unauthorized.publicKey,
          borrower: fixture.borrower.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts([
          { pubkey: lender.contributionPda, isSigner: false, isWritable: false },
          { pubkey: lender.escrowPda, isSigner: false, isWritable: true },
          { pubkey: lender.escrowUsdcAta, isSigner: false, isWritable: true },
        ])
        .signers([unauthorized])
        .rpc();
      assert.fail("expected non-bot signer to be rejected");
    } catch (error) {
      assert.match(parseErrorMessage(error), /UnauthorizedBotOperation/);
    }

    try {
      await program.methods
        .partialLiquidate(toBn(100_000_000n))
        .accounts({
          contract: fixture.contractPda,
          state: statePda,
          collateralRegistry: collateralRegistryPda,
          priceFeedAccount: fixture.collateralType.oraclePriceFeed,
          botUsdcAta: botUsdcAta.address,
          contractUsdcAta: fixture.contractUsdcAta,
          contractCollateralAta: fixture.contractCollateralAta,
          botCollateralAta: botCollateralAta.address,
          treasury: treasuryPda,
          botAuthority: provider.wallet.publicKey,
          borrower: fixture.borrower.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts([
          { pubkey: lender.contributionPda, isSigner: false, isWritable: false },
          { pubkey: lender.escrowPda, isSigner: false, isWritable: true },
          { pubkey: lender.escrowUsdcAta, isSigner: false, isWritable: true },
        ])
        .rpc();
      assert.fail("expected healthy position rejection");
    } catch (error) {
      assert.match(parseErrorMessage(error), /PositionHealthy/);
    }

    const thresholdBps = fixture.ltvFloorBps + fixture.collateralType.liquidationBufferBps;
    const thresholdPrice = computeThresholdPrice(
      fixture.collateralAmount,
      fixture.collateralType.decimals,
      fixture.targetAmount,
      thresholdBps,
    );
    await upsertMockOraclePriceFeed(fixture.oracleFeedSeed, thresholdPrice - 1n, -8);

    const before = await program.account.debtContract.fetch(fixture.contractPda);
    await program.methods
      .partialLiquidate(toBn(requestedRepay))
      .accounts({
        contract: fixture.contractPda,
        state: statePda,
        collateralRegistry: collateralRegistryPda,
        priceFeedAccount: fixture.collateralType.oraclePriceFeed,
        botUsdcAta: botUsdcAta.address,
        contractUsdcAta: fixture.contractUsdcAta,
        contractCollateralAta: fixture.contractCollateralAta,
        botCollateralAta: botCollateralAta.address,
        treasury: treasuryPda,
        botAuthority: provider.wallet.publicKey,
        borrower: fixture.borrower.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts([
        { pubkey: lender.contributionPda, isSigner: false, isWritable: false },
        { pubkey: lender.escrowPda, isSigner: false, isWritable: true },
        { pubkey: lender.escrowUsdcAta, isSigner: false, isWritable: true },
      ])
      .rpc();

    const after = await program.account.debtContract.fetch(fixture.contractPda);
    const escrowAfter = await program.account.lenderEscrow.fetch(lender.escrowPda);
    const balBefore = BigInt(before.outstandingBalance.toString());
    const balAfter = BigInt(after.outstandingBalance.toString());
    const repaid = BigInt(escrowAfter.availablePrincipal.toString());
    assert.isAtMost(Number(repaid), Number((balBefore * 5_000n) / 10_000n) + 100);
    const drift = balAfter - (balBefore - repaid);
    assert.isAtMost(Number(drift), 100, "post-liquidation balance drift should be negligible (interest accrual)");
  });

  it("supports sequential partial liquidations, seizure math, and escrow claims", async function () {
    if (!mockOracleAvailable) return this.skip();
    const fixture = await createContractFixture({
      loanType: "committed",
      targetAmount: 1_000_000_000n,
      ltvFloorBps: 11_000,
      oracleFeedSeed: nextOracleSeed(),
      oraclePrice: 250_000_000_000n,
    });
    const lender = await contributeToContract(fixture, fixture.targetAmount);
    const { botUsdcAta, botCollateralAta, borrowerCollateralAta } = await getBotLiquidationAccounts(
      fixture.usdcMint,
      fixture.collateralType.mint,
      fixture.borrowerCollateralAta,
    );
    await mintTo(
      connection,
      payer,
      fixture.usdcMint,
      botUsdcAta,
      provider.wallet.publicKey,
      1_500_000_000n,
    );

    const thresholdBps = fixture.ltvFloorBps + fixture.collateralType.liquidationBufferBps;
    const thresholdPrice = computeThresholdPrice(
      fixture.collateralAmount,
      fixture.collateralType.decimals,
      fixture.targetAmount,
      thresholdBps,
    );
    const firstPrice = thresholdPrice - 1n;
    await upsertMockOraclePriceFeed(fixture.oracleFeedSeed, firstPrice, -8);

    const before = await program.account.debtContract.fetch(fixture.contractPda);
    const beforeOutstanding = BigInt(before.outstandingBalance.toString());
    const beforeCollateral = BigInt(before.collateralAmount.toString());

    await program.methods
      .partialLiquidate(toBn(700_000_000n))
      .accounts({
        contract: fixture.contractPda,
        state: statePda,
        collateralRegistry: collateralRegistryPda,
        priceFeedAccount: fixture.collateralType.oraclePriceFeed,
        botUsdcAta,
        contractUsdcAta: fixture.contractUsdcAta,
        contractCollateralAta: fixture.contractCollateralAta,
        botCollateralAta,
        treasury: treasuryPda,
        botAuthority: provider.wallet.publicKey,
        borrower: fixture.borrower.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts([
        { pubkey: lender.contributionPda, isSigner: false, isWritable: false },
        { pubkey: lender.escrowPda, isSigner: false, isWritable: true },
        { pubkey: lender.escrowUsdcAta, isSigner: false, isWritable: true },
      ])
      .rpc();

    const afterFirst = await program.account.debtContract.fetch(fixture.contractPda);
    const escrowAfterFirst = await program.account.lenderEscrow.fetch(lender.escrowPda);
    const cappedRepay = BigInt(escrowAfterFirst.availablePrincipal.toString());
    const afterOutstanding = BigInt(afterFirst.outstandingBalance.toString());
    const drift1 = afterOutstanding - (beforeOutstanding - cappedRepay);
    assert.isAtMost(Number(drift1), 100,
      "first partial liquidation should apply ~50% outstanding cap (small interest drift allowed)",
    );
    assert.isAtMost(Number(cappedRepay), Number((beforeOutstanding * 5_000n) / 10_000n) + 1,
      "single lender should receive capped repay in escrow",
    );

    const collateralValueUsdc =
      (beforeCollateral * firstPrice * 1_000_000n) /
      (10n ** BigInt(fixture.collateralType.decimals) * 100_000_000n);
    const expectedSeized =
      (cappedRepay * 10_300n * beforeCollateral) / (collateralValueUsdc * 10_000n);
    const actualSeized =
      beforeCollateral - BigInt(afterFirst.collateralAmount.toString());
    assert.equal(
      actualSeized.toString(),
      expectedSeized.toString(),
      "seized collateral should match liquidation formula",
    );

    const lenderBalanceBeforeClaim = await getAccount(connection, lender.lenderUsdcAta);
    await program.methods
      .claimFromEscrow()
      .accounts({
        contract: fixture.contractPda,
        escrow: lender.escrowPda,
        lender: lender.lender.publicKey,
        escrowUsdcAccount: lender.escrowUsdcAta,
        lenderUsdcAccount: lender.lenderUsdcAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([lender.lender])
      .rpc();
    const lenderBalanceAfterClaim = await getAccount(connection, lender.lenderUsdcAta);
    assert.equal(
      (lenderBalanceAfterClaim.amount - lenderBalanceBeforeClaim.amount).toString(),
      cappedRepay.toString(),
      "claim should release escrowed principal from partial liquidation",
    );

    const afterFirstOutstanding = BigInt(afterFirst.outstandingBalance.toString());
    const afterFirstCollateral = BigInt(afterFirst.collateralAmount.toString());
    const thresholdPriceSecond = computeThresholdPrice(
      afterFirstCollateral,
      fixture.collateralType.decimals,
      afterFirstOutstanding,
      thresholdBps,
    );
    await upsertMockOraclePriceFeed(fixture.oracleFeedSeed, thresholdPriceSecond - 1n, -8);

    await program.methods
      .partialLiquidate(toBn(100_000_000n))
      .accounts({
        contract: fixture.contractPda,
        state: statePda,
        collateralRegistry: collateralRegistryPda,
        priceFeedAccount: fixture.collateralType.oraclePriceFeed,
        botUsdcAta,
        contractUsdcAta: fixture.contractUsdcAta,
        contractCollateralAta: fixture.contractCollateralAta,
        botCollateralAta,
        treasury: treasuryPda,
        botAuthority: provider.wallet.publicKey,
        borrower: fixture.borrower.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts([
        { pubkey: lender.contributionPda, isSigner: false, isWritable: false },
        { pubkey: lender.escrowPda, isSigner: false, isWritable: true },
        { pubkey: lender.escrowUsdcAta, isSigner: false, isWritable: true },
      ])
      .rpc();

    const afterSecond = await program.account.debtContract.fetch(fixture.contractPda);
    assert.isTrue(
      BigInt(afterSecond.outstandingBalance.toString()) < afterFirstOutstanding,
      "second partial liquidation should reduce outstanding balance further",
    );
  });

  it("rejects partial liquidation for stale oracle and legacy v1 contracts", async function () {
    if (!mockOracleAvailable) return this.skip();
    const fixture = await createContractFixture({
      loanType: "committed",
      targetAmount: 400_000_000n,
      ltvFloorBps: 11_000,
      oracleFeedSeed: nextOracleSeed(),
      oraclePrice: 250_000_000_000n,
    });
    const lender = await contributeToContract(fixture, fixture.targetAmount);
    const { botUsdcAta, botCollateralAta, borrowerCollateralAta } = await getBotLiquidationAccounts(
      fixture.usdcMint,
      fixture.collateralType.mint,
      fixture.borrowerCollateralAta,
    );
    await mintTo(
      connection,
      payer,
      fixture.usdcMint,
      botUsdcAta,
      provider.wallet.publicKey,
      500_000_000n,
    );

    const thresholdBps = fixture.ltvFloorBps + fixture.collateralType.liquidationBufferBps;
    const thresholdPrice = computeThresholdPrice(
      fixture.collateralAmount,
      fixture.collateralType.decimals,
      fixture.targetAmount,
      thresholdBps,
    );
    const stalePublishTime = (await getOnchainUnixTimestamp()) - 120;
    await upsertMockOraclePriceFeed(fixture.oracleFeedSeed, thresholdPrice - 1n, -8, stalePublishTime);

    try {
      await program.methods
        .partialLiquidate(toBn(100_000_000n))
        .accounts({
          contract: fixture.contractPda,
          state: statePda,
          collateralRegistry: collateralRegistryPda,
          priceFeedAccount: fixture.collateralType.oraclePriceFeed,
          botUsdcAta,
          contractUsdcAta: fixture.contractUsdcAta,
          contractCollateralAta: fixture.contractCollateralAta,
          botCollateralAta,
          treasury: treasuryPda,
          botAuthority: provider.wallet.publicKey,
          borrower: fixture.borrower.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts([
          { pubkey: lender.contributionPda, isSigner: false, isWritable: false },
          { pubkey: lender.escrowPda, isSigner: false, isWritable: true },
          { pubkey: lender.escrowUsdcAta, isSigner: false, isWritable: true },
        ])
        .rpc();
      assert.fail("expected partial liquidation to reject stale oracle");
    } catch (error) {
      assert.match(parseErrorMessage(error), /OraclePriceStale/);
    }

    const v1Borrower = anchor.web3.Keypair.generate();
    await airdropSol(connection, v1Borrower, 0.03);

    const v1Seed = nextContractSeed();
    const [v1ContractPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("debt_contract"), v1Borrower.publicKey.toBuffer(), u64ToLeBytes(v1Seed)],
      program.programId,
    );
    const [v1OperationsPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("operations_fund"), v1ContractPda.toBuffer()],
      program.programId,
    );

    try {
      await program.methods
        .createDebtContract(
          v1Seed,
          14,
          new anchor.BN(40_000_000),
          new anchor.BN(500),
          30,
          new anchor.BN(25_000_000),
          { committed: {} },
          new anchor.BN(8_000),
          8_000,
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
          contract: v1ContractPda,
          operationsFund: v1OperationsPda,
          state: statePda,
          treasury: treasuryPda,
          borrower: v1Borrower.publicKey,
          systemProgram: SystemProgram.programId,
          collateralRegistry: null,
          collateralMint: null,
          borrowerCollateralAta: null,
          contractCollateralAta: null,
          priceFeedAccount: null,
          usdcMint: null,
          contractUsdcAta: null,
          borrowerUsdcAta: null,
          treasuryUsdcAccount: null,
          tokenProgram: null,
          associatedTokenProgram: null,
        })
        .signers([v1Borrower])
        .rpc();
      assert.fail("expected v1 contract creation with null accounts to fail");
    } catch (error) {
      assert.match(
        parseErrorMessage(error),
        /MissingTokenAccounts|Account `contract` not provided\./,
      );
    }
  });

  it("rejects full liquidation when oracle price data is stale", async function () {
    if (!mockOracleAvailable) return this.skip();
    const fixture = await createContractFixture({
      loanType: "committed",
      targetAmount: 400_000_000n,
      ltvFloorBps: 11_000,
      oracleFeedSeed: nextOracleSeed(),
      oraclePrice: 250_000_000_000n,
    });
    const lender = await contributeToContract(fixture, fixture.targetAmount);
    const { botUsdcAta, botCollateralAta, borrowerCollateralAta } = await getBotLiquidationAccounts(
      fixture.usdcMint,
      fixture.collateralType.mint,
      fixture.borrowerCollateralAta,
    );
    await mintTo(
      connection,
      payer,
      fixture.usdcMint,
      botUsdcAta,
      provider.wallet.publicKey,
      fixture.targetAmount,
    );

    const thresholdPrice = computeThresholdPrice(
      fixture.collateralAmount,
      fixture.collateralType.decimals,
      fixture.targetAmount,
      fixture.ltvFloorBps,
    );
    const stalePublishTime = (await getOnchainUnixTimestamp()) - 120;
    await upsertMockOraclePriceFeed(fixture.oracleFeedSeed, thresholdPrice - 1n, -8, stalePublishTime);

    try {
      await program.methods
        .liquidateContract()
        .accounts({
          contract: fixture.contractPda,
          operationsFund: fixture.operationsFundPda,
          state: statePda,
          testClockOffset: null,
          borrower: fixture.borrower.publicKey,
          liquidator: provider.wallet.publicKey,
          systemProgram: SystemProgram.programId,
          collateralRegistry: collateralRegistryPda,
          priceFeedAccount: fixture.collateralType.oraclePriceFeed,
          treasury: treasuryPda,
          botUsdcAta,
          contractUsdcAta: fixture.contractUsdcAta,
          contractCollateralAta: fixture.contractCollateralAta,
          botCollateralAta,
          borrowerCollateralAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .remainingAccounts([
          { pubkey: lender.contributionPda, isSigner: false, isWritable: false },
          { pubkey: lender.escrowPda, isSigner: false, isWritable: true },
          { pubkey: lender.escrowUsdcAta, isSigner: false, isWritable: true },
        ])
        .rpc();
      assert.fail("expected liquidate_contract to reject stale oracle data");
    } catch (error) {
      assert.match(parseErrorMessage(error), /OraclePriceStale/);
    }
  });

  it("supports full liquidation on price trigger, returns excess collateral, and tracks a 3% fee", async function () {
    if (!mockOracleAvailable) return this.skip();
    const fixture = await createContractFixture({
      loanType: "committed",
      targetAmount: 600_000_000n,
      ltvFloorBps: 11_000,
      oracleFeedSeed: nextOracleSeed(),
      oraclePrice: 250_000_000_000n,
    });
    const lender = await contributeToContract(fixture, fixture.targetAmount);
    const { botUsdcAta, botCollateralAta, borrowerCollateralAta } = await getBotLiquidationAccounts(
      fixture.usdcMint,
      fixture.collateralType.mint,
      fixture.borrowerCollateralAta,
    );
    await mintTo(
      connection,
      payer,
      fixture.usdcMint,
      botUsdcAta,
      provider.wallet.publicKey,
      fixture.targetAmount,
    );

    const thresholdPrice = computeThresholdPrice(
      fixture.collateralAmount,
      fixture.collateralType.decimals,
      fixture.targetAmount,
      fixture.ltvFloorBps,
    );
    await upsertMockOraclePriceFeed(fixture.oracleFeedSeed, thresholdPrice - 1n, -8);
    const treasuryBefore = await program.account.treasury.fetch(treasuryPda);
    const stateBefore = await program.account.state.fetch(statePda);
    const borrowerCollateralBefore = await getAccount(connection, fixture.borrowerCollateralAta);
    const botCollateralBefore = await getAccount(connection, botCollateralAta);

    await program.methods
      .liquidateContract()
      .accounts({
        contract: fixture.contractPda,
        operationsFund: fixture.operationsFundPda,
        state: statePda,
        testClockOffset: null,
        borrower: fixture.borrower.publicKey,
        liquidator: provider.wallet.publicKey,
        systemProgram: SystemProgram.programId,
        collateralRegistry: collateralRegistryPda,
        priceFeedAccount: fixture.collateralType.oraclePriceFeed,
        treasury: treasuryPda,
        botUsdcAta,
        contractUsdcAta: fixture.contractUsdcAta,
        contractCollateralAta: fixture.contractCollateralAta,
        botCollateralAta,
        borrowerCollateralAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .remainingAccounts([
        { pubkey: lender.contributionPda, isSigner: false, isWritable: false },
        { pubkey: lender.escrowPda, isSigner: false, isWritable: true },
        { pubkey: lender.escrowUsdcAta, isSigner: false, isWritable: true },
      ])
      .rpc();

    const contractAfter = await program.account.debtContract.fetch(fixture.contractPda);
    const collateralAtaInfo = await connection.getAccountInfo(fixture.contractCollateralAta);
    const treasuryAfter = await program.account.treasury.fetch(treasuryPda);
    const stateAfter = await program.account.state.fetch(statePda);
    const escrowAfter = await program.account.lenderEscrow.fetch(lender.escrowPda);
    const borrowerCollateralAfter = await getAccount(connection, fixture.borrowerCollateralAta);
    const botCollateralAfter = await getAccount(connection, botCollateralAta);
    const borrowerCollateralDelta = borrowerCollateralAfter.amount - borrowerCollateralBefore.amount;
    const botCollateralDelta = botCollateralAfter.amount - botCollateralBefore.amount;
    const botPaysUsdc = BigInt(escrowAfter.availablePrincipal.toString());
    const expectedLiquidationFee = (botPaysUsdc * 300n) / 10_000n;
    const treasuryFeeDelta =
      BigInt(treasuryAfter.totalLiquidationFees.toString()) -
      BigInt(treasuryBefore.totalLiquidationFees.toString());

    expectAnchorEnumVariant(contractAfter.status, "liquidated");
    assert.isNull(collateralAtaInfo, "full liquidation should close collateral ATA");
    assert.isTrue(borrowerCollateralDelta > 0n, "borrower should receive excess collateral");
    assert.isTrue(
      botCollateralDelta < fixture.collateralAmount,
      "bot should not seize all collateral when surplus exists",
    );
    assert.equal(
      treasuryFeeDelta.toString(),
      expectedLiquidationFee.toString(),
      "treasury fee should equal 3% of bot USDC repayment",
    );
    assert.equal(
      stateAfter.totalLiquidations.toString(),
      stateBefore.totalLiquidations.add(new anchor.BN(1)).toString(),
    );
  });

  it("supports full liquidation when underwater with no borrower excess", async function () {
    if (!mockOracleAvailable) return this.skip();
    const fixture = await createContractFixture({
      loanType: "committed",
      targetAmount: 500_000_000n,
      ltvFloorBps: 11_000,
      oracleFeedSeed: nextOracleSeed(),
      oraclePrice: 250_000_000_000n,
    });
    const lender = await contributeToContract(fixture, fixture.targetAmount);
    const { botUsdcAta, botCollateralAta, borrowerCollateralAta } = await getBotLiquidationAccounts(
      fixture.usdcMint,
      fixture.collateralType.mint,
      fixture.borrowerCollateralAta,
    );
    await mintTo(
      connection,
      payer,
      fixture.usdcMint,
      botUsdcAta,
      provider.wallet.publicKey,
      fixture.targetAmount,
    );
    await upsertMockOraclePriceFeed(fixture.oracleFeedSeed, 1_000_000n, -8);

    const borrowerCollateralBefore = await getAccount(connection, fixture.borrowerCollateralAta);
    const botCollateralBefore = await getAccount(connection, botCollateralAta);

    await program.methods
      .liquidateContract()
      .accounts({
        contract: fixture.contractPda,
        operationsFund: fixture.operationsFundPda,
        state: statePda,
        testClockOffset: null,
        borrower: fixture.borrower.publicKey,
        liquidator: provider.wallet.publicKey,
        systemProgram: SystemProgram.programId,
        collateralRegistry: collateralRegistryPda,
        priceFeedAccount: fixture.collateralType.oraclePriceFeed,
        treasury: treasuryPda,
        botUsdcAta,
        contractUsdcAta: fixture.contractUsdcAta,
        contractCollateralAta: fixture.contractCollateralAta,
        botCollateralAta,
        borrowerCollateralAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .remainingAccounts([
        { pubkey: lender.contributionPda, isSigner: false, isWritable: false },
        { pubkey: lender.escrowPda, isSigner: false, isWritable: true },
        { pubkey: lender.escrowUsdcAta, isSigner: false, isWritable: true },
      ])
      .rpc();

    const contractAfter = await program.account.debtContract.fetch(fixture.contractPda);
    const collateralAtaInfo = await connection.getAccountInfo(fixture.contractCollateralAta);
    const borrowerCollateralAfter = await getAccount(connection, fixture.borrowerCollateralAta);
    const botCollateralAfter = await getAccount(connection, botCollateralAta);
    const borrowerCollateralDelta = borrowerCollateralAfter.amount - borrowerCollateralBefore.amount;
    const botCollateralDelta = botCollateralAfter.amount - botCollateralBefore.amount;

    expectAnchorEnumVariant(contractAfter.status, "liquidated");
    assert.isNull(collateralAtaInfo, "full liquidation should close collateral ATA");
    assert.equal(
      borrowerCollateralDelta.toString(),
      "0",
      "underwater liquidation should not return excess collateral",
    );
    assert.equal(
      botCollateralDelta.toString(),
      fixture.collateralAmount.toString(),
      "underwater liquidation should transfer all collateral to the bot",
    );
  });

  it("supports full liquidation at the collateral equals debt boundary", async function () {
    if (!mockOracleAvailable) return this.skip();
    const fixture = await createContractFixture({
      loanType: "committed",
      targetAmount: 500_000_000n,
      ltvFloorBps: 11_000,
      oracleFeedSeed: nextOracleSeed(),
      oraclePrice: 250_000_000_000n,
    });
    const lender = await contributeToContract(fixture, fixture.targetAmount);
    const { botUsdcAta, botCollateralAta, borrowerCollateralAta } = await getBotLiquidationAccounts(
      fixture.usdcMint,
      fixture.collateralType.mint,
      fixture.borrowerCollateralAta,
    );
    await mintTo(
      connection,
      payer,
      fixture.usdcMint,
      botUsdcAta,
      provider.wallet.publicKey,
      fixture.targetAmount,
    );

    const boundaryPrice = computeThresholdPrice(
      fixture.collateralAmount,
      fixture.collateralType.decimals,
      fixture.targetAmount,
      10_000,
    );
    await upsertMockOraclePriceFeed(fixture.oracleFeedSeed, boundaryPrice, -8);

    const collateralValueAtBoundary =
      (fixture.collateralAmount * boundaryPrice * 1_000_000n) /
      (10n ** BigInt(fixture.collateralType.decimals) * 100_000_000n);
    assert.isTrue(
      absBigInt(collateralValueAtBoundary - fixture.targetAmount) <= 1n,
      "boundary setup should value collateral at approximately outstanding debt",
    );

    const borrowerCollateralBefore = await getAccount(connection, fixture.borrowerCollateralAta);
    const botCollateralBefore = await getAccount(connection, botCollateralAta);

    await program.methods
      .liquidateContract()
      .accounts({
        contract: fixture.contractPda,
        operationsFund: fixture.operationsFundPda,
        state: statePda,
        testClockOffset: null,
        borrower: fixture.borrower.publicKey,
        liquidator: provider.wallet.publicKey,
        systemProgram: SystemProgram.programId,
        collateralRegistry: collateralRegistryPda,
        priceFeedAccount: fixture.collateralType.oraclePriceFeed,
        treasury: treasuryPda,
        botUsdcAta,
        contractUsdcAta: fixture.contractUsdcAta,
        contractCollateralAta: fixture.contractCollateralAta,
        botCollateralAta,
        borrowerCollateralAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .remainingAccounts([
        { pubkey: lender.contributionPda, isSigner: false, isWritable: false },
        { pubkey: lender.escrowPda, isSigner: false, isWritable: true },
        { pubkey: lender.escrowUsdcAta, isSigner: false, isWritable: true },
      ])
      .rpc();

    const contractAfter = await program.account.debtContract.fetch(fixture.contractPda);
    const collateralAtaInfo = await connection.getAccountInfo(fixture.contractCollateralAta);
    const borrowerCollateralAfter = await getAccount(connection, fixture.borrowerCollateralAta);
    const botCollateralAfter = await getAccount(connection, botCollateralAta);
    const borrowerCollateralDelta = borrowerCollateralAfter.amount - borrowerCollateralBefore.amount;
    const botCollateralDelta = botCollateralAfter.amount - botCollateralBefore.amount;

    expectAnchorEnumVariant(contractAfter.status, "liquidated");
    assert.isNull(collateralAtaInfo, "full liquidation should close collateral ATA");
    assert.equal(
      borrowerCollateralDelta.toString(),
      "0",
      "boundary liquidation should not leave material excess collateral",
    );
    assert.equal(
      (botCollateralDelta + borrowerCollateralDelta).toString(),
      fixture.collateralAmount.toString(),
      "all collateral should be distributed between bot and borrower",
    );
  });

  it("supports time-triggered full liquidation for committed loans", async function () {
    if (!mockOracleAvailable) return this.skip();
    const fixture = await createContractFixture({
      loanType: "committed",
      targetAmount: 300_000_000n,
      ltvFloorBps: 11_000,
      oracleFeedSeed: nextOracleSeed(),
      oraclePrice: 250_000_000_000n,
      termDays: 0,
    });
    const lender = await contributeToContract(fixture, fixture.targetAmount);
    const { botUsdcAta, botCollateralAta, borrowerCollateralAta } = await getBotLiquidationAccounts(
      fixture.usdcMint,
      fixture.collateralType.mint,
      fixture.borrowerCollateralAta,
    );
    await mintTo(
      connection,
      payer,
      fixture.usdcMint,
      botUsdcAta,
      provider.wallet.publicKey,
      fixture.targetAmount,
    );

    await setTestClockOffset(2);
    try {
      await upsertMockOraclePriceFeed(fixture.oracleFeedSeed, 250_000_000_000n, -8);
      await program.methods
        .liquidateContract()
        .accounts({
          contract: fixture.contractPda,
          operationsFund: fixture.operationsFundPda,
          state: statePda,
          testClockOffset: testClockOffsetPda,
          borrower: fixture.borrower.publicKey,
          liquidator: provider.wallet.publicKey,
          systemProgram: SystemProgram.programId,
          collateralRegistry: collateralRegistryPda,
          priceFeedAccount: fixture.collateralType.oraclePriceFeed,
          treasury: treasuryPda,
          botUsdcAta,
          contractUsdcAta: fixture.contractUsdcAta,
          contractCollateralAta: fixture.contractCollateralAta,
          botCollateralAta,
          borrowerCollateralAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .remainingAccounts([
          { pubkey: lender.contributionPda, isSigner: false, isWritable: false },
          { pubkey: lender.escrowPda, isSigner: false, isWritable: true },
          { pubkey: lender.escrowUsdcAta, isSigner: false, isWritable: true },
        ])
        .rpc();
    } finally {
      await setTestClockOffset(0);
    }

    const contractAfter = await program.account.debtContract.fetch(fixture.contractPda);
    expectAnchorEnumVariant(contractAfter.status, "liquidated");
  });

  it("supports full liquidation when a demand contract enters pending recall", async function () {
    if (!mockOracleAvailable) return this.skip();
    const fixture = await createContractFixture({
      loanType: "demand",
      targetAmount: 350_000_000n,
      ltvFloorBps: 11_000,
      oracleFeedSeed: nextOracleSeed(),
      oraclePrice: 250_000_000_000n,
    });
    const lender = await contributeToContract(fixture, fixture.targetAmount);
    await program.methods
      .requestRecall()
      .accounts({
        contract: fixture.contractPda,
        state: statePda,
        lender: lender.lender.publicKey,
        contribution: lender.contributionPda,
      })
      .signers([lender.lender])
      .rpc();

    const { botUsdcAta, botCollateralAta, borrowerCollateralAta } = await getBotLiquidationAccounts(
      fixture.usdcMint,
      fixture.collateralType.mint,
      fixture.borrowerCollateralAta,
    );
    await mintTo(
      connection,
      payer,
      fixture.usdcMint,
      botUsdcAta,
      provider.wallet.publicKey,
      fixture.targetAmount,
    );
    await upsertMockOraclePriceFeed(fixture.oracleFeedSeed, 250_000_000_000n, -8);

    await program.methods
      .liquidateContract()
      .accounts({
        contract: fixture.contractPda,
        operationsFund: fixture.operationsFundPda,
        state: statePda,
        testClockOffset: null,
        borrower: fixture.borrower.publicKey,
        liquidator: provider.wallet.publicKey,
        systemProgram: SystemProgram.programId,
        collateralRegistry: collateralRegistryPda,
        priceFeedAccount: fixture.collateralType.oraclePriceFeed,
        treasury: treasuryPda,
        botUsdcAta,
        contractUsdcAta: fixture.contractUsdcAta,
        contractCollateralAta: fixture.contractCollateralAta,
        botCollateralAta,
        borrowerCollateralAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .remainingAccounts([
        { pubkey: lender.contributionPda, isSigner: false, isWritable: false },
        { pubkey: lender.escrowPda, isSigner: false, isWritable: true },
        { pubkey: lender.escrowUsdcAta, isSigner: false, isWritable: true },
      ])
      .rpc();

    const contractAfter = await program.account.debtContract.fetch(fixture.contractPda);
    expectAnchorEnumVariant(contractAfter.status, "liquidated");
  });

  it("handles bad debt and supports partial-then-full liquidation progression", async function () {
    if (!mockOracleAvailable) return this.skip();
    const fixture = await createContractFixture({
      loanType: "committed",
      targetAmount: 800_000_000n,
      ltvFloorBps: 11_000,
      oracleFeedSeed: nextOracleSeed(),
      oraclePrice: 250_000_000_000n,
    });
    const lender = await contributeToContract(fixture, fixture.targetAmount);
    const { botUsdcAta, botCollateralAta, borrowerCollateralAta } = await getBotLiquidationAccounts(
      fixture.usdcMint,
      fixture.collateralType.mint,
      fixture.borrowerCollateralAta,
    );
    await mintTo(
      connection,
      payer,
      fixture.usdcMint,
      botUsdcAta,
      provider.wallet.publicKey,
      1_000_000_000n,
    );

    const thresholdBps = fixture.ltvFloorBps + fixture.collateralType.liquidationBufferBps;
    const thresholdPricePartial = computeThresholdPrice(
      fixture.collateralAmount,
      fixture.collateralType.decimals,
      fixture.targetAmount,
      thresholdBps,
    );
    await upsertMockOraclePriceFeed(fixture.oracleFeedSeed, thresholdPricePartial - 1n, -8);
    await program.methods
      .partialLiquidate(toBn(200_000_000n))
      .accounts({
        contract: fixture.contractPda,
        state: statePda,
        collateralRegistry: collateralRegistryPda,
        priceFeedAccount: fixture.collateralType.oraclePriceFeed,
        botUsdcAta,
        contractUsdcAta: fixture.contractUsdcAta,
        contractCollateralAta: fixture.contractCollateralAta,
        botCollateralAta,
        treasury: treasuryPda,
        botAuthority: provider.wallet.publicKey,
        borrower: fixture.borrower.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts([
        { pubkey: lender.contributionPda, isSigner: false, isWritable: false },
        { pubkey: lender.escrowPda, isSigner: false, isWritable: true },
        { pubkey: lender.escrowUsdcAta, isSigner: false, isWritable: true },
      ])
      .rpc();

    await upsertMockOraclePriceFeed(fixture.oracleFeedSeed, 1_000_000n, -8);
    await program.methods
      .liquidateContract()
      .accounts({
        contract: fixture.contractPda,
        operationsFund: fixture.operationsFundPda,
        state: statePda,
        testClockOffset: null,
        borrower: fixture.borrower.publicKey,
        liquidator: provider.wallet.publicKey,
        systemProgram: SystemProgram.programId,
        collateralRegistry: collateralRegistryPda,
        priceFeedAccount: fixture.collateralType.oraclePriceFeed,
        treasury: treasuryPda,
        botUsdcAta,
        contractUsdcAta: fixture.contractUsdcAta,
        contractCollateralAta: fixture.contractCollateralAta,
        botCollateralAta,
        borrowerCollateralAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .remainingAccounts([
        { pubkey: lender.contributionPda, isSigner: false, isWritable: false },
        { pubkey: lender.escrowPda, isSigner: false, isWritable: true },
        { pubkey: lender.escrowUsdcAta, isSigner: false, isWritable: true },
      ])
      .rpc();

    const contractAfter = await program.account.debtContract.fetch(fixture.contractPda);
    const escrowAfter = await program.account.lenderEscrow.fetch(lender.escrowPda);


    expectAnchorEnumVariant(contractAfter.status, "liquidated");
    assert.equal(
      contractAfter.collateralAmount.toString(),
      "0",
      "all collateral should be seized in bad debt liquidation",
    );
    assert.isTrue(
      BigInt(escrowAfter.availablePrincipal.toString()) < fixture.targetAmount,
      "escrow principal should reflect collateral-limited recovery (bad debt)",
    );
  });

  it("supports demand recall request and borrower repay flow", async function () {
    if (!mockOracleAvailable) return this.skip();
    const fixture = await createContractFixture({
      loanType: "demand",
      targetAmount: 1_000_000_000n,
      ltvFloorBps: 11_000,
      oracleFeedSeed: nextOracleSeed(),
      oraclePrice: 250_000_000_000n,
    });
    const lenderA = await contributeToContract(fixture, 600_000_000n);
    const lenderB = await contributeToContract(fixture, 400_000_000n);

    await program.methods
      .requestRecall()
      .accounts({
        contract: fixture.contractPda,
        state: statePda,
        lender: lenderA.lender.publicKey,
        contribution: lenderA.contributionPda,
      })
      .signers([lenderA.lender])
      .rpc();

    try {
      await program.methods
        .requestRecall()
        .accounts({
          contract: fixture.contractPda,
          state: statePda,
          lender: lenderB.lender.publicKey,
          contribution: lenderB.contributionPda,
        })
        .signers([lenderB.lender])
        .rpc();
      assert.fail("expected a second concurrent recall to fail");
    } catch (error) {
      assert.match(parseErrorMessage(error), /RecallAlreadyPending/);
    }

    const borrowerUsdcBeforeRepay = await getAccount(connection, fixture.borrowerUsdcAta);
    const borrowerCollateralBeforeRepay = await getAccount(connection, fixture.borrowerCollateralAta);
    const contractCollateralBeforeRepay = await getAccount(connection, fixture.contractCollateralAta);
    const recalledEscrowBeforeRepay = await getAccount(connection, lenderA.escrowUsdcAta);
    const beforeRepay = await program.account.debtContract.fetch(fixture.contractPda);
    await program.methods
      .borrowerRepayRecall()
      .accounts({
        contract: fixture.contractPda,
        borrower: fixture.borrower.publicKey,
        contribution: lenderA.contributionPda,
        escrow: lenderA.escrowPda,
        borrowerUsdcAta: fixture.borrowerUsdcAta,
        contractUsdcAta: fixture.contractUsdcAta,
        escrowUsdcAta: lenderA.escrowUsdcAta,
        contractCollateralAta: fixture.contractCollateralAta,
        borrowerCollateralAta: fixture.borrowerCollateralAta,
        state: statePda,
        testClockOffset: null,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([fixture.borrower])
      .rpc();

    const borrowerUsdcAfterRepay = await getAccount(connection, fixture.borrowerUsdcAta);
    const borrowerCollateralAfterRepay = await getAccount(connection, fixture.borrowerCollateralAta);
    const contractCollateralAfterRepay = await getAccount(connection, fixture.contractCollateralAta);
    const recalledEscrowAfterRepay = await getAccount(connection, lenderA.escrowUsdcAta);
    const afterRepay = await program.account.debtContract.fetch(fixture.contractPda);
    const recalledContribution = await program.account.lenderContribution.fetch(lenderA.contributionPda);
    expectAnchorEnumVariant(afterRepay.status, "active");
    assert.equal(afterRepay.numContributions, 1);
    assert.equal(recalledContribution.isRefunded, true);
    assert.equal(
      (borrowerUsdcBeforeRepay.amount - borrowerUsdcAfterRepay.amount).toString(),
      lenderA.amount.toString(),
      "borrower must repay exactly the recalled lender principal",
    );
    assert.equal(
      (recalledEscrowAfterRepay.amount - recalledEscrowBeforeRepay.amount).toString(),
      lenderA.amount.toString(),
      "recalled lender escrow ATA should receive the recalled principal",
    );
    assert.isTrue(
      borrowerCollateralAfterRepay.amount > borrowerCollateralBeforeRepay.amount,
      "borrower should recover collateral on successful recall repay",
    );
    assert.isTrue(
      contractCollateralAfterRepay.amount < contractCollateralBeforeRepay.amount,
      "contract collateral should decrease when collateral is returned",
    );

    const lhs =
      BigInt(beforeRepay.collateralAmount.toString()) * BigInt(afterRepay.outstandingBalance.toString());
    const rhs =
      BigInt(afterRepay.collateralAmount.toString()) * BigInt(beforeRepay.outstandingBalance.toString());
    const delta = lhs > rhs ? lhs - rhs : rhs - lhs;
    assert.isAtMost(
      Number(delta),
      Number(BigInt(beforeRepay.outstandingBalance.toString())),
      "recall repayment should preserve collateral/debt ratio up to integer rounding",
    );
  });

  it("enforces recall grace period before bot processing", async function () {
    if (!mockOracleAvailable) return this.skip();
    const fixture = await createContractFixture({
      loanType: "demand",
      targetAmount: 1_000_000_000n,
      ltvFloorBps: 11_000,
      oracleFeedSeed: nextOracleSeed(),
      oraclePrice: 250_000_000_000n,
    });
    const lender = await contributeToContract(fixture, fixture.targetAmount);

    await program.methods
      .requestRecall()
      .accounts({
        contract: fixture.contractPda,
        state: statePda,
        lender: lender.lender.publicKey,
        contribution: lender.contributionPda,
      })
      .signers([lender.lender])
      .rpc();

    const botUsdcAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      fixture.usdcMint,
      provider.wallet.publicKey,
    );
    const botCollateralAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      fixture.collateralType.mint,
      provider.wallet.publicKey,
    );

    try {
      await program.methods
        .processRecall()
        .accounts({
          contract: fixture.contractPda,
          botAuthority: provider.wallet.publicKey,
          treasury: treasuryPda,
          contribution: lender.contributionPda,
          escrow: lender.escrowPda,
          botUsdcAta: botUsdcAta.address,
          contractUsdcAta: fixture.contractUsdcAta,
          escrowUsdcAta: lender.escrowUsdcAta,
          treasuryUsdcAta: fixture.treasuryUsdcAta,
          contractCollateralAta: fixture.contractCollateralAta,
          botCollateralAta: botCollateralAta.address,
          borrower: fixture.borrower.publicKey,
          state: statePda,
          testClockOffset: null,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      assert.fail("expected process_recall to fail before grace period elapsed");
    } catch (error) {
      assert.match(parseErrorMessage(error), /RecallGracePeriodNotElapsed/);
    }
  });

  it("splits listing fees for registered frontends and falls back when missing/invalid", async function () {
    if (!mockOracleAvailable) return this.skip();
    if (!hasRegisterFrontendInstruction) {
      return this.skip();
    }

    const stateBefore = await program.account.state.fetch(statePda);
    const previousPrimaryListingFeeBps = stateBefore.primaryListingFeeBps as number;
    await program.methods
      .updateFeeRates(null, null, 1, null, null)
      .accounts({
        state: statePda,
        authority: provider.wallet.publicKey,
      })
      .rpc();

    const frontend = anchor.web3.Keypair.generate();
    await airdropSol(connection, frontend, 0.02);
    const frontendOperatorPda = await localRegisterFrontendOperator(frontend);
    const usdcMint = await getCanonicalUsdcMint();
    const frontendUsdcAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      usdcMint,
      frontend.publicKey,
    );

    const wrongFrontendOwner = anchor.web3.Keypair.generate();
    await airdropSol(connection, wrongFrontendOwner, 0.02);
    const wrongFrontendAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      usdcMint,
      wrongFrontendOwner.publicKey,
    );
    const treasuryUsdcAtaAddress = (
      await getOrCreateAssociatedTokenAccount(connection, payer, usdcMint, treasuryPda, true)
    ).address;

    try {
      const treasuryBeforeWithFrontend = await getAccount(connection, treasuryUsdcAtaAddress);
      const frontendBefore = await getAccount(connection, frontendUsdcAta.address);
      const fixtureWithFrontend = await createContractFixture({
        loanType: "demand",
        targetAmount: 1_000_000n,
        ltvFloorBps: 11_000,
        oracleFeedSeed: nextOracleSeed(),
        oraclePrice: 250_000_000_000n,
        frontendOperatorPda,
        frontendUsdcAta: frontendUsdcAta.address,
      });
      const contractWithFrontend = await program.account.debtContract.fetch(
        fixtureWithFrontend.contractPda,
      );
      const listingFeeWithFrontend = BigInt(contractWithFrontend.listingFeePaid.toString());
      const expectedFrontendShare = listingFeeWithFrontend / 2n;
      const expectedTreasuryShare = listingFeeWithFrontend - expectedFrontendShare;
      const treasuryAfterWithFrontend = await getAccount(connection, treasuryUsdcAtaAddress);
      const frontendAfter = await getAccount(connection, frontendUsdcAta.address);

      assert.equal(
        (treasuryAfterWithFrontend.amount - treasuryBeforeWithFrontend.amount).toString(),
        expectedTreasuryShare.toString(),
      );
      assert.equal(
        (frontendAfter.amount - frontendBefore.amount).toString(),
        expectedFrontendShare.toString(),
      );

      const treasuryBeforeWithoutFrontend = await getAccount(connection, treasuryUsdcAtaAddress);
      const frontendBeforeWithoutFrontend = await getAccount(connection, frontendUsdcAta.address);
      const fixtureWithoutFrontend = await createContractFixture({
        loanType: "demand",
        targetAmount: 1_000_000n,
        ltvFloorBps: 11_000,
        oracleFeedSeed: nextOracleSeed(),
        oraclePrice: 250_000_000_000n,
      });
      const contractWithoutFrontend = await program.account.debtContract.fetch(
        fixtureWithoutFrontend.contractPda,
      );
      const listingFeeWithoutFrontend = BigInt(contractWithoutFrontend.listingFeePaid.toString());
      const treasuryAfterWithoutFrontend = await getAccount(connection, treasuryUsdcAtaAddress);
      const frontendAfterWithoutFrontend = await getAccount(connection, frontendUsdcAta.address);

      assert.equal(
        (treasuryAfterWithoutFrontend.amount - treasuryBeforeWithoutFrontend.amount).toString(),
        listingFeeWithoutFrontend.toString(),
      );
      assert.equal(
        (frontendAfterWithoutFrontend.amount - frontendBeforeWithoutFrontend.amount).toString(),
        "0",
      );

      try {
        await createContractFixture({
          loanType: "demand",
          targetAmount: 1_000_000n,
          ltvFloorBps: 11_000,
          oracleFeedSeed: nextOracleSeed(),
          oraclePrice: 250_000_000_000n,
          frontendOperatorPda,
          frontendUsdcAta: wrongFrontendAta.address,
        });
        assert.fail("expected listing creation with mismatched frontend ATA owner to fail");
      } catch (error) {
        assert.match(parseErrorMessage(error), /FrontendTokenAccountMismatch/);
      }
    } finally {
      await program.methods
        .updateFeeRates(null, null, previousPrimaryListingFeeBps, null, null)
        .accounts({
          state: statePda,
          authority: provider.wallet.publicKey,
        })
        .rpc();
    }
  });

  it("splits recall fees for stored frontends and falls back to treasury otherwise", async function () {
    if (!mockOracleAvailable) return this.skip();
    if (!hasRegisterFrontendInstruction) {
      return this.skip();
    }

    const frontend = anchor.web3.Keypair.generate();
    await airdropSol(connection, frontend, 0.02);
    const frontendOperatorPda = await localRegisterFrontendOperator(frontend);
    const frontendUsdcAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      await getCanonicalUsdcMint(),
      frontend.publicKey,
    );

    const fixtureWithFrontend = await createContractFixture({
      loanType: "demand",
      targetAmount: 300_000_000n,
      ltvFloorBps: 11_000,
      oracleFeedSeed: nextOracleSeed(),
      oraclePrice: 250_000_000_000n,
      frontendOperatorPda,
      frontendUsdcAta: frontendUsdcAta.address,
    });
    const recalledLender = await contributeToContract(fixtureWithFrontend, fixtureWithFrontend.targetAmount);
    await program.methods
      .requestRecall()
      .accounts({
        contract: fixtureWithFrontend.contractPda,
        state: statePda,
        lender: recalledLender.lender.publicKey,
        contribution: recalledLender.contributionPda,
      })
      .signers([recalledLender.lender])
      .rpc();

    const { botUsdcAta, botCollateralAta } = await getBotLiquidationAccounts(
      fixtureWithFrontend.usdcMint,
      fixtureWithFrontend.collateralType.mint,
      fixtureWithFrontend.borrowerCollateralAta,
    );
    await mintTo(
      connection,
      payer,
      fixtureWithFrontend.usdcMint,
      botUsdcAta,
      provider.wallet.publicKey,
      recalledLender.amount,
    );

    const treasuryBeforeSplit = await getAccount(connection, fixtureWithFrontend.treasuryUsdcAta);
    const frontendBeforeSplit = await getAccount(connection, frontendUsdcAta.address);
    await setTestClockOffset(259_300);
    try {
      await program.methods
        .processRecall()
        .accountsPartial({
          contract: fixtureWithFrontend.contractPda,
          botAuthority: provider.wallet.publicKey,
          treasury: treasuryPda,
          contribution: recalledLender.contributionPda,
          escrow: recalledLender.escrowPda,
          botUsdcAta,
          contractUsdcAta: fixtureWithFrontend.contractUsdcAta,
          escrowUsdcAta: recalledLender.escrowUsdcAta,
          treasuryUsdcAta: fixtureWithFrontend.treasuryUsdcAta,
          contractCollateralAta: fixtureWithFrontend.contractCollateralAta,
          botCollateralAta,
          borrower: fixtureWithFrontend.borrower.publicKey,
          state: statePda,
          testClockOffset: testClockOffsetPda,
          frontendUsdcAta: frontendUsdcAta.address,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    } finally {
      await setTestClockOffset(0);
    }
    const expectedRecallFeeSplit = (recalledLender.amount * 200n) / 10_000n;
    const expectedFrontendRecallShare = expectedRecallFeeSplit / 2n;
    const treasuryAfterSplit = await getAccount(connection, fixtureWithFrontend.treasuryUsdcAta);
    const frontendAfterSplit = await getAccount(connection, frontendUsdcAta.address);
    assert.equal(
      (treasuryAfterSplit.amount - treasuryBeforeSplit.amount).toString(),
      (expectedRecallFeeSplit - expectedFrontendRecallShare).toString(),
    );
    assert.equal(
      (frontendAfterSplit.amount - frontendBeforeSplit.amount).toString(),
      expectedFrontendRecallShare.toString(),
    );

    const fixtureStoredNoAta = await createContractFixture({
      loanType: "demand",
      targetAmount: 250_000_000n,
      ltvFloorBps: 11_000,
      oracleFeedSeed: nextOracleSeed(),
      oraclePrice: 250_000_000_000n,
      frontendOperatorPda,
      frontendUsdcAta: frontendUsdcAta.address,
    });
    const noAtaLender = await contributeToContract(fixtureStoredNoAta, fixtureStoredNoAta.targetAmount);
    await program.methods
      .requestRecall()
      .accounts({
        contract: fixtureStoredNoAta.contractPda,
        state: statePda,
        lender: noAtaLender.lender.publicKey,
        contribution: noAtaLender.contributionPda,
      })
      .signers([noAtaLender.lender])
      .rpc();
    const noAtaBotAccounts = await getBotLiquidationAccounts(
      fixtureStoredNoAta.usdcMint,
      fixtureStoredNoAta.collateralType.mint,
      fixtureStoredNoAta.borrowerCollateralAta,
    );
    await mintTo(
      connection,
      payer,
      fixtureStoredNoAta.usdcMint,
      noAtaBotAccounts.botUsdcAta,
      provider.wallet.publicKey,
      noAtaLender.amount,
    );
    const treasuryBeforeNoAta = await getAccount(connection, fixtureStoredNoAta.treasuryUsdcAta);
    const frontendBeforeNoAta = await getAccount(connection, frontendUsdcAta.address);
    await setTestClockOffset(259_300);
    try {
      await program.methods
        .processRecall()
        .accountsPartial({
          contract: fixtureStoredNoAta.contractPda,
          botAuthority: provider.wallet.publicKey,
          treasury: treasuryPda,
          contribution: noAtaLender.contributionPda,
          escrow: noAtaLender.escrowPda,
          botUsdcAta: noAtaBotAccounts.botUsdcAta,
          contractUsdcAta: fixtureStoredNoAta.contractUsdcAta,
          escrowUsdcAta: noAtaLender.escrowUsdcAta,
          treasuryUsdcAta: fixtureStoredNoAta.treasuryUsdcAta,
          contractCollateralAta: fixtureStoredNoAta.contractCollateralAta,
          botCollateralAta: noAtaBotAccounts.botCollateralAta,
          borrower: fixtureStoredNoAta.borrower.publicKey,
          state: statePda,
          testClockOffset: testClockOffsetPda,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    } finally {
      await setTestClockOffset(0);
    }
    const expectedNoAtaRecallFee = (noAtaLender.amount * 200n) / 10_000n;
    const treasuryAfterNoAta = await getAccount(connection, fixtureStoredNoAta.treasuryUsdcAta);
    const frontendAfterNoAta = await getAccount(connection, frontendUsdcAta.address);
    assert.equal(
      (treasuryAfterNoAta.amount - treasuryBeforeNoAta.amount).toString(),
      expectedNoAtaRecallFee.toString(),
    );
    assert.equal(
      (frontendAfterNoAta.amount - frontendBeforeNoAta.amount).toString(),
      "0",
    );

    const fixtureNoFrontend = await createContractFixture({
      loanType: "demand",
      targetAmount: 200_000_000n,
      ltvFloorBps: 11_000,
      oracleFeedSeed: nextOracleSeed(),
      oraclePrice: 250_000_000_000n,
    });
    const legacyLender = await contributeToContract(fixtureNoFrontend, fixtureNoFrontend.targetAmount);
    await program.methods
      .requestRecall()
      .accounts({
        contract: fixtureNoFrontend.contractPda,
        state: statePda,
        lender: legacyLender.lender.publicKey,
        contribution: legacyLender.contributionPda,
      })
      .signers([legacyLender.lender])
      .rpc();
    const legacyBotAccounts = await getBotLiquidationAccounts(
      fixtureNoFrontend.usdcMint,
      fixtureNoFrontend.collateralType.mint,
      fixtureNoFrontend.borrowerCollateralAta,
    );
    await mintTo(
      connection,
      payer,
      fixtureNoFrontend.usdcMint,
      legacyBotAccounts.botUsdcAta,
      provider.wallet.publicKey,
      legacyLender.amount,
    );
    const treasuryBeforeLegacy = await getAccount(connection, fixtureNoFrontend.treasuryUsdcAta);
    await setTestClockOffset(259_300);
    try {
      await program.methods
        .processRecall()
        .accountsPartial({
          contract: fixtureNoFrontend.contractPda,
          botAuthority: provider.wallet.publicKey,
          treasury: treasuryPda,
          contribution: legacyLender.contributionPda,
          escrow: legacyLender.escrowPda,
          botUsdcAta: legacyBotAccounts.botUsdcAta,
          contractUsdcAta: fixtureNoFrontend.contractUsdcAta,
          escrowUsdcAta: legacyLender.escrowUsdcAta,
          treasuryUsdcAta: fixtureNoFrontend.treasuryUsdcAta,
          contractCollateralAta: fixtureNoFrontend.contractCollateralAta,
          botCollateralAta: legacyBotAccounts.botCollateralAta,
          borrower: fixtureNoFrontend.borrower.publicKey,
          state: statePda,
          testClockOffset: testClockOffsetPda,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    } finally {
      await setTestClockOffset(0);
    }
    const expectedLegacyRecallFee = (legacyLender.amount * 200n) / 10_000n;
    const treasuryAfterLegacy = await getAccount(connection, fixtureNoFrontend.treasuryUsdcAta);
    assert.equal(
      (treasuryAfterLegacy.amount - treasuryBeforeLegacy.amount).toString(),
      expectedLegacyRecallFee.toString(),
    );
  });

  it("processes recall after grace period with fee accounting and escrow payout", async function () {
    if (!mockOracleAvailable) return this.skip();
    const fixture = await createContractFixture({
      loanType: "demand",
      targetAmount: 1_000_000_000n,
      ltvFloorBps: 11_000,
      oracleFeedSeed: nextOracleSeed(),
      oraclePrice: 250_000_000_000n,
    });
    const lenderA = await contributeToContract(fixture, 600_000_000n);
    const lenderB = await contributeToContract(fixture, 400_000_000n);
    await program.methods
      .requestRecall()
      .accounts({
        contract: fixture.contractPda,
        state: statePda,
        lender: lenderA.lender.publicKey,
        contribution: lenderA.contributionPda,
      })
      .signers([lenderA.lender])
      .rpc();

    const { botUsdcAta, botCollateralAta } = await getBotLiquidationAccounts(
      fixture.usdcMint,
      fixture.collateralType.mint,
      fixture.borrowerCollateralAta,
    );
    await mintTo(
      connection,
      payer,
      fixture.usdcMint,
      botUsdcAta,
      provider.wallet.publicKey,
      700_000_000n,
    );
    const treasuryBefore = await program.account.treasury.fetch(treasuryPda);
    await setTestClockOffset(259_300);
    try {
      try {
        await program.methods
          .processRecall()
          .accounts({
            contract: fixture.contractPda,
            botAuthority: provider.wallet.publicKey,
            treasury: treasuryPda,
            contribution: lenderB.contributionPda,
            escrow: lenderB.escrowPda,
            botUsdcAta,
            contractUsdcAta: fixture.contractUsdcAta,
            escrowUsdcAta: lenderB.escrowUsdcAta,
            treasuryUsdcAta: fixture.treasuryUsdcAta,
            contractCollateralAta: fixture.contractCollateralAta,
            botCollateralAta,
            borrower: fixture.borrower.publicKey,
            state: statePda,
            testClockOffset: testClockOffsetPda,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
        assert.fail("expected process_recall with wrong contribution to fail");
      } catch (error) {
        assert.match(parseErrorMessage(error), /InvalidContribution/);
      }

      await program.methods
        .processRecall()
        .accounts({
          contract: fixture.contractPda,
          botAuthority: provider.wallet.publicKey,
          treasury: treasuryPda,
          contribution: lenderA.contributionPda,
          escrow: lenderA.escrowPda,
          botUsdcAta,
          contractUsdcAta: fixture.contractUsdcAta,
          escrowUsdcAta: lenderA.escrowUsdcAta,
          treasuryUsdcAta: fixture.treasuryUsdcAta,
          contractCollateralAta: fixture.contractCollateralAta,
          botCollateralAta,
          borrower: fixture.borrower.publicKey,
          state: statePda,
          testClockOffset: testClockOffsetPda,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    } finally {
      await setTestClockOffset(0);
    }

    const expectedRecallAmount = lenderA.amount;
    const expectedFee = (expectedRecallAmount * 200n) / 10_000n;
    const expectedLenderReceives = expectedRecallAmount - expectedFee;
    const contractAfter = await program.account.debtContract.fetch(fixture.contractPda);
    const escrowAfter = await program.account.lenderEscrow.fetch(lenderA.escrowPda);
    const contributionAfter = await program.account.lenderContribution.fetch(lenderA.contributionPda);
    const treasuryAfter = await program.account.treasury.fetch(treasuryPda);
    expectAnchorEnumVariant(contractAfter.status, "active");
    assert.equal(contractAfter.numContributions, 1);
    assert.equal(
      contractAfter.outstandingBalance.toString(),
      (fixture.targetAmount - expectedRecallAmount).toString(),
    );
    assert.equal(escrowAfter.availablePrincipal.toString(), expectedLenderReceives.toString());
    assert.equal(contributionAfter.isRefunded, true);
    assert.equal(
      BigInt(treasuryAfter.totalRecallFees.toString()) -
        BigInt(treasuryBefore.totalRecallFees.toString()),
      expectedFee,
    );

    const lenderBeforeClaim = await getAccount(connection, lenderA.lenderUsdcAta);
    await program.methods
      .claimFromEscrow()
      .accounts({
        contract: fixture.contractPda,
        escrow: lenderA.escrowPda,
        lender: lenderA.lender.publicKey,
        escrowUsdcAccount: lenderA.escrowUsdcAta,
        lenderUsdcAccount: lenderA.lenderUsdcAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([lenderA.lender])
      .rpc();
    const lenderAfterClaim = await getAccount(connection, lenderA.lenderUsdcAta);
    assert.equal(
      (lenderAfterClaim.amount - lenderBeforeClaim.amount).toString(),
      expectedLenderReceives.toString(),
    );
  });

  it("marks contract completed when last lender recall is processed", async function () {
    if (!mockOracleAvailable) return this.skip();
    const fixture = await createContractFixture({
      loanType: "demand",
      targetAmount: 300_000_000n,
      ltvFloorBps: 11_000,
      oracleFeedSeed: nextOracleSeed(),
      oraclePrice: 250_000_000_000n,
    });
    const lender = await contributeToContract(fixture, fixture.targetAmount);
    await program.methods
      .requestRecall()
      .accounts({
        contract: fixture.contractPda,
        state: statePda,
        lender: lender.lender.publicKey,
        contribution: lender.contributionPda,
      })
      .signers([lender.lender])
      .rpc();
    const { botUsdcAta, botCollateralAta } = await getBotLiquidationAccounts(
      fixture.usdcMint,
      fixture.collateralType.mint,
      fixture.borrowerCollateralAta,
    );
    await mintTo(
      connection,
      payer,
      fixture.usdcMint,
      botUsdcAta,
      provider.wallet.publicKey,
      400_000_000n,
    );
    await setTestClockOffset(259_300);
    try {
      await program.methods
        .processRecall()
        .accounts({
          contract: fixture.contractPda,
          botAuthority: provider.wallet.publicKey,
          treasury: treasuryPda,
          contribution: lender.contributionPda,
          escrow: lender.escrowPda,
          botUsdcAta,
          contractUsdcAta: fixture.contractUsdcAta,
          escrowUsdcAta: lender.escrowUsdcAta,
          treasuryUsdcAta: fixture.treasuryUsdcAta,
          contractCollateralAta: fixture.contractCollateralAta,
          botCollateralAta,
          borrower: fixture.borrower.publicKey,
          state: statePda,
          testClockOffset: testClockOffsetPda,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    } finally {
      await setTestClockOffset(0);
    }

    const contractAfter = await program.account.debtContract.fetch(fixture.contractPda);
    expectAnchorEnumVariant(contractAfter.status, "completed");
    assert.equal(contractAfter.numContributions, 0);
  });

  it("rejects borrower_repay_recall without pending recall and after grace expiry", async function () {
    if (!mockOracleAvailable) return this.skip();
    const fixture = await createContractFixture({
      loanType: "demand",
      targetAmount: 300_000_000n,
      ltvFloorBps: 11_000,
      oracleFeedSeed: nextOracleSeed(),
      oraclePrice: 250_000_000_000n,
    });
    const lender = await contributeToContract(fixture, fixture.targetAmount);

    try {
      await program.methods
        .borrowerRepayRecall()
        .accounts({
          contract: fixture.contractPda,
          borrower: fixture.borrower.publicKey,
          contribution: lender.contributionPda,
          escrow: lender.escrowPda,
          borrowerUsdcAta: fixture.borrowerUsdcAta,
          contractUsdcAta: fixture.contractUsdcAta,
          escrowUsdcAta: lender.escrowUsdcAta,
          contractCollateralAta: fixture.contractCollateralAta,
          borrowerCollateralAta: fixture.borrowerCollateralAta,
          state: statePda,
          testClockOffset: null,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([fixture.borrower])
        .rpc();
      assert.fail("expected borrower_repay_recall without pending recall to fail");
    } catch (error) {
      assert.match(parseErrorMessage(error), /NoRecallPending/);
    }

    await program.methods
      .requestRecall()
      .accounts({
        contract: fixture.contractPda,
        state: statePda,
        lender: lender.lender.publicKey,
        contribution: lender.contributionPda,
      })
      .signers([lender.lender])
      .rpc();
    await setTestClockOffset(259_300);
    try {
      await program.methods
        .borrowerRepayRecall()
        .accounts({
          contract: fixture.contractPda,
          borrower: fixture.borrower.publicKey,
          contribution: lender.contributionPda,
          escrow: lender.escrowPda,
          borrowerUsdcAta: fixture.borrowerUsdcAta,
          contractUsdcAta: fixture.contractUsdcAta,
          escrowUsdcAta: lender.escrowUsdcAta,
          contractCollateralAta: fixture.contractCollateralAta,
          borrowerCollateralAta: fixture.borrowerCollateralAta,
          state: statePda,
          testClockOffset: testClockOffsetPda,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([fixture.borrower])
        .rpc();
      assert.fail("expected borrower_repay_recall after grace expiry to fail");
    } catch (error) {
      assert.match(parseErrorMessage(error), /RecallGracePeriodElapsed/);
    } finally {
      await setTestClockOffset(0);
    }
  });

  it("verifies value/collateral conservation and rent safety invariants", async function () {
    if (!mockOracleAvailable) return this.skip();
    const oracleSeed = nextOracleSeed();
    const fixture = await createContractFixture({
      loanType: "committed",
      targetAmount: 120_000_000n,
      ltvFloorBps: 11_500,
      oracleFeedSeed: oracleSeed,
      oraclePrice: 250_000_000_000n,
    });
    const borrowerUsdcBeforeContributions = await getAccount(connection, fixture.borrowerUsdcAta);
    const lenderA = await contributeToContract(fixture, 70_000_000n);
    const lenderB = await contributeToContract(fixture, 50_000_000n);
    const contractBeforeRepay = await program.account.debtContract.fetch(fixture.contractPda);
    const collateralBeforeRepay = BigInt(contractBeforeRepay.collateralAmount.toString());

    const lenderAAfterContribution = await getAccount(connection, lenderA.lenderUsdcAta);
    const lenderBAfterContribution = await getAccount(connection, lenderB.lenderUsdcAta);
    const borrowerUsdcAfterFunding = await getAccount(connection, fixture.borrowerUsdcAta);
    const treasuryUsdcBefore = await getAccount(connection, fixture.treasuryUsdcAta);
    const borrowerCollateralBeforeRepay = await getAccount(connection, fixture.borrowerCollateralAta);
    const contractInfoBefore = await connection.getAccountInfo(fixture.contractPda);
    assert.isNotNull(contractInfoBefore);
    const rentExemptMinimum = await connection.getMinimumBalanceForRentExemption(
      contractInfoBefore?.data.length ?? 0,
    );
    const contractLamportsBefore = await connection.getBalance(fixture.contractPda);

    assert.equal(
      (borrowerUsdcAfterFunding.amount - borrowerUsdcBeforeContributions.amount).toString(),
      fixture.targetAmount.toString(),
      "contributed USDC must be disbursed to the borrower at activation",
    );

    await program.methods
      .makePaymentWithDistribution(toBn(fixture.targetAmount))
      .accounts({
        contract: fixture.contractPda,
        operationsFund: fixture.operationsFundPda,
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
        { pubkey: lenderA.contributionPda, isSigner: false, isWritable: false },
        { pubkey: lenderA.escrowPda, isSigner: false, isWritable: true },
        { pubkey: lenderA.escrowUsdcAta, isSigner: false, isWritable: true },
        { pubkey: lenderB.contributionPda, isSigner: false, isWritable: false },
        { pubkey: lenderB.escrowPda, isSigner: false, isWritable: true },
        { pubkey: lenderB.escrowUsdcAta, isSigner: false, isWritable: true },
      ])
      .signers([fixture.borrower])
      .rpc();

    const borrowerUsdcAfterRepay = await getAccount(connection, fixture.borrowerUsdcAta);
    const borrowerRepayDelta = borrowerUsdcAfterFunding.amount - borrowerUsdcAfterRepay.amount;
    assert.equal(
      borrowerRepayDelta.toString(),
      fixture.targetAmount.toString(),
      "borrower repayment must match funded principal for zero-interest fixtures",
    );

    await program.methods
      .claimFromEscrow()
      .accounts({
        contract: fixture.contractPda,
        escrow: lenderA.escrowPda,
        lender: lenderA.lender.publicKey,
        escrowUsdcAccount: lenderA.escrowUsdcAta,
        lenderUsdcAccount: lenderA.lenderUsdcAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([lenderA.lender])
      .rpc();
    await program.methods
      .claimFromEscrow()
      .accounts({
        contract: fixture.contractPda,
        escrow: lenderB.escrowPda,
        lender: lenderB.lender.publicKey,
        escrowUsdcAccount: lenderB.escrowUsdcAta,
        lenderUsdcAccount: lenderB.lenderUsdcAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([lenderB.lender])
      .rpc();

    const lenderAAfterClaim = await getAccount(connection, lenderA.lenderUsdcAta);
    const lenderBAfterClaim = await getAccount(connection, lenderB.lenderUsdcAta);
    const totalClaimed =
      lenderAAfterClaim.amount -
      lenderAAfterContribution.amount +
      (lenderBAfterClaim.amount - lenderBAfterContribution.amount);
    assert.equal(
      totalClaimed.toString(),
      fixture.targetAmount.toString(),
      "lender claims must conserve principal after borrower repayment",
    );

    const treasuryUsdcAfter = await getAccount(connection, fixture.treasuryUsdcAta);
    assert.equal(
      (treasuryUsdcAfter.amount - treasuryUsdcBefore.amount).toString(),
      "0",
      "plain repayment path should not accrue treasury USDC fees",
    );

    const contractAfter = await program.account.debtContract.fetch(fixture.contractPda);
    expectAnchorEnumVariant(contractAfter.status, "completed");
    assert.equal(contractAfter.outstandingBalance.toNumber(), 0);
    assert.equal(collateralBeforeRepay.toString(), fixture.collateralAmount.toString());
    assert.equal(contractAfter.collateralAmount.toString(), "0");

    if (fixture.collateralType.mint.equals(NATIVE_MINT)) {
      const contractCollateralInfo = await connection.getAccountInfo(fixture.contractCollateralAta);
      assert.isNull(
        contractCollateralInfo,
        "native collateral ATA should close on completion to unwrap wSOL",
      );
    } else {
      const borrowerCollateralAfterRepay = await getAccount(connection, fixture.borrowerCollateralAta);
      const contractCollateralAfterRepay = await getAccount(connection, fixture.contractCollateralAta);
      assert.equal(
        (borrowerCollateralAfterRepay.amount - borrowerCollateralBeforeRepay.amount).toString(),
        fixture.collateralAmount.toString(),
        "terminal collateral must equal initial collateral for non-liquidated contracts",
      );
      assert.equal(contractCollateralAfterRepay.amount.toString(), "0");
    }

    const contractLamportsAfter = await connection.getBalance(fixture.contractPda);
    assert.isAtLeast(
      contractLamportsBefore,
      rentExemptMinimum,
      "contract must remain rent-exempt during active lifecycle",
    );
    assert.isAtLeast(
      contractLamportsAfter,
      rentExemptMinimum,
      "contract must remain rent-exempt after completion",
    );
  });

  it("preserves recall LTV ratio and exact 2% recall fee", async function () {
    if (!mockOracleAvailable) return this.skip();
    const oracleSeed = nextOracleSeed();
    const fixture = await createContractFixture({
      loanType: "demand",
      targetAmount: 100_000_000n,
      ltvFloorBps: 11_500,
      oracleFeedSeed: oracleSeed,
      oraclePrice: 240_000_000_000n,
    });
    const recalledLender = await contributeToContract(fixture, 60_000_000n);
    await contributeToContract(fixture, 40_000_000n);

    await program.methods
      .requestRecall()
      .accounts({
        contract: fixture.contractPda,
        state: statePda,
        lender: recalledLender.lender.publicKey,
        contribution: recalledLender.contributionPda,
      })
      .signers([recalledLender.lender])
      .rpc();

    const beforeProcess = await program.account.debtContract.fetch(fixture.contractPda);
    const preCollateral = BigInt(beforeProcess.collateralAmount.toString());
    const preDebt = BigInt(beforeProcess.outstandingBalance.toString());
    assert.isTrue(preDebt > 0n);

    const { botUsdcAta, botCollateralAta } = await getBotLiquidationAccounts(
      fixture.usdcMint,
      fixture.collateralType.mint,
      fixture.borrowerCollateralAta,
    );
    await mintTo(
      connection,
      payer,
      fixture.usdcMint,
      botUsdcAta,
      provider.wallet.publicKey,
      recalledLender.amount,
    );

    const treasuryUsdcBefore = await getAccount(connection, fixture.treasuryUsdcAta);

    await setTestClockOffset(259_300);
    try {
      await program.methods
        .processRecall()
        .accounts({
          contract: fixture.contractPda,
          contribution: recalledLender.contributionPda,
          escrow: recalledLender.escrowPda,
          botAuthority: provider.wallet.publicKey,
          botUsdcAta,
          contractUsdcAta: fixture.contractUsdcAta,
          botCollateralAta,
          escrowUsdcAta: recalledLender.escrowUsdcAta,
          treasury: treasuryPda,
          treasuryUsdcAta: fixture.treasuryUsdcAta,
          contractCollateralAta: fixture.contractCollateralAta,
          state: statePda,
          borrower: fixture.borrower.publicKey,
          testClockOffset: testClockOffsetPda,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    } finally {
      await setTestClockOffset(0);
    }

    const afterProcess = await program.account.debtContract.fetch(fixture.contractPda);
    const postCollateral = BigInt(afterProcess.collateralAmount.toString());
    const postDebt = BigInt(afterProcess.outstandingBalance.toString());
    assert.isTrue(postDebt > 0n);

    const ratioDrift = absBigInt(preCollateral * postDebt - postCollateral * preDebt);
    assert.isTrue(
      ratioDrift <= preDebt,
      "recall must preserve collateral-to-debt ratio within integer rounding tolerance",
    );

    const expectedRecallFee = (recalledLender.amount * 200n) / 10_000n;
    const treasuryUsdcAfter = await getAccount(connection, fixture.treasuryUsdcAta);
    assert.equal(
      (treasuryUsdcAfter.amount - treasuryUsdcBefore.amount).toString(),
      expectedRecallFee.toString(),
      "treasury fee must equal 2% of recalled amount",
    );
  });

  it("rejects process_recall account substitution across lender escrows", async function () {
    if (!mockOracleAvailable) return this.skip();
    const oracleSeed = nextOracleSeed();
    const fixture = await createContractFixture({
      loanType: "demand",
      targetAmount: 100_000_000n,
      ltvFloorBps: 11_500,
      oracleFeedSeed: oracleSeed,
      oraclePrice: 240_000_000_000n,
    });
    const lenderA = await contributeToContract(fixture, 60_000_000n);
    const lenderB = await contributeToContract(fixture, 40_000_000n);

    await program.methods
      .requestRecall()
      .accounts({
        contract: fixture.contractPda,
        state: statePda,
        lender: lenderA.lender.publicKey,
        contribution: lenderA.contributionPda,
      })
      .signers([lenderA.lender])
      .rpc();

    const { botUsdcAta, botCollateralAta } = await getBotLiquidationAccounts(
      fixture.usdcMint,
      fixture.collateralType.mint,
      fixture.borrowerCollateralAta,
    );
    await mintTo(
      connection,
      payer,
      fixture.usdcMint,
      botUsdcAta,
      provider.wallet.publicKey,
      lenderA.amount,
    );

    await setTestClockOffset(259_300);
    try {
      await program.methods
        .processRecall()
        .accounts({
          contract: fixture.contractPda,
          contribution: lenderA.contributionPda,
          escrow: lenderB.escrowPda,
          botAuthority: provider.wallet.publicKey,
          botUsdcAta,
          contractUsdcAta: fixture.contractUsdcAta,
          botCollateralAta,
          escrowUsdcAta: lenderB.escrowUsdcAta,
          treasury: treasuryPda,
          treasuryUsdcAta: fixture.treasuryUsdcAta,
          contractCollateralAta: fixture.contractCollateralAta,
          state: statePda,
          borrower: fixture.borrower.publicKey,
          testClockOffset: testClockOffsetPda,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      assert.fail("expected process_recall with mismatched escrow account to fail");
    } catch (error) {
      assert.match(parseErrorMessage(error), /(UnauthorizedClaim|InvalidContribution)/);
    } finally {
      await setTestClockOffset(0);
    }
  });

  it("handles dust-sized lifecycle amounts without arithmetic faults", async function () {
    if (!mockOracleAvailable) return this.skip();
    const oracleSeed = nextOracleSeed();
    const fixture = await createContractFixture({
      loanType: "committed",
      targetAmount: 1_000n,
      ltvFloorBps: 11_500,
      oracleFeedSeed: oracleSeed,
      oraclePrice: 250_000_000_000n,
    });
    const lender = await contributeToContract(fixture, 1_000n);

    await program.methods
      .makePaymentWithDistribution(toBn(1_000n))
      .accounts({
        contract: fixture.contractPda,
        operationsFund: fixture.operationsFundPda,
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
        { pubkey: lender.contributionPda, isSigner: false, isWritable: false },
        { pubkey: lender.escrowPda, isSigner: false, isWritable: true },
        { pubkey: lender.escrowUsdcAta, isSigner: false, isWritable: true },
      ])
      .signers([fixture.borrower])
      .rpc();

    await program.methods
      .claimFromEscrow()
      .accounts({
        contract: fixture.contractPda,
        escrow: lender.escrowPda,
        lender: lender.lender.publicKey,
        escrowUsdcAccount: lender.escrowUsdcAta,
        lenderUsdcAccount: lender.lenderUsdcAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([lender.lender])
      .rpc();

    const contractAfter = await program.account.debtContract.fetch(fixture.contractPda);
    expectAnchorEnumVariant(contractAfter.status, "completed");
    assert.equal(contractAfter.outstandingBalance.toNumber(), 0);
  });

  it("enforces PDA uniqueness across borrowers and lenders", async () => {
    const contractSeed = new anchor.BN(424242);
    const borrowerA = anchor.web3.Keypair.generate();
    const borrowerB = anchor.web3.Keypair.generate();
    const lenderA = anchor.web3.Keypair.generate();
    const lenderB = anchor.web3.Keypair.generate();
    const [contractA] = PublicKey.findProgramAddressSync(
      [Buffer.from("debt_contract"), borrowerA.publicKey.toBuffer(), u64ToLeBytes(contractSeed)],
      program.programId,
    );
    const [contractB] = PublicKey.findProgramAddressSync(
      [Buffer.from("debt_contract"), borrowerB.publicKey.toBuffer(), u64ToLeBytes(contractSeed)],
      program.programId,
    );
    assert.notEqual(contractA.toBase58(), contractB.toBase58());

    const [contributionA] = PublicKey.findProgramAddressSync(
      [Buffer.from("contribution"), contractA.toBuffer(), lenderA.publicKey.toBuffer()],
      program.programId,
    );
    const [contributionB] = PublicKey.findProgramAddressSync(
      [Buffer.from("contribution"), contractA.toBuffer(), lenderB.publicKey.toBuffer()],
      program.programId,
    );
    assert.notEqual(contributionA.toBase58(), contributionB.toBase58());
  });

  it("supports cancel with SPL collateral return", async function () {
    if (!mockOracleAvailable) return this.skip();
    const oracleSeed = nextOracleSeed();
    const fixture = await createContractFixture({
      loanType: "committed",
      targetAmount: 90_000_000n,
      ltvFloorBps: 11_000,
      oracleFeedSeed: oracleSeed,
      oraclePrice: 250_000_000_000n,
    });

    const borrowerCollateralBefore = await getAccount(connection, fixture.borrowerCollateralAta);
    const contractCollateralBefore = await getAccount(connection, fixture.contractCollateralAta);
    assert.equal(
      contractCollateralBefore.amount.toString(),
      fixture.collateralAmount.toString(),
      "contract collateral ATA should hold full posted collateral before cancel",
    );

    await program.methods
      .cancelContract()
      .accounts({
        contract: fixture.contractPda,
        operationsFund: fixture.operationsFundPda,
        borrower: fixture.borrower.publicKey,
        contractCollateralAta: fixture.contractCollateralAta,
        borrowerCollateralAta: fixture.borrowerCollateralAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([fixture.borrower])
      .rpc();

    const contractAfter = await program.account.debtContract.fetch(fixture.contractPda);
    const borrowerCollateralAfter = await getAccount(connection, fixture.borrowerCollateralAta);
    const contractCollateralAfter = await getAccount(connection, fixture.contractCollateralAta);
    expectAnchorEnumVariant(contractAfter.status, "cancelled");
    assert.equal(contractAfter.collateralAmount.toString(), "0");
    assert.equal(
      borrowerCollateralAfter.amount.toString(),
      (borrowerCollateralBefore.amount + fixture.collateralAmount).toString(),
      "borrower should receive posted SPL collateral back on cancel",
    );
    assert.equal(contractCollateralAfter.amount.toString(), "0");
  });

  it("supports cancel with wSOL collateral unwrap", async function () {
    if (!mockOracleAvailable) return this.skip();
    const oracleFeedSeed = nextOracleSeed();
    const oraclePrice = 250_000_000_000n;
    const oracleFeed = await upsertMockOraclePriceFeed(oracleFeedSeed, oraclePrice, -8);
    const wsolCollateralType = await ensureCollateralTypeForMint(
      NATIVE_MINT,
      oracleFeed,
      9,
      500,
      11_000,
    );
    const fixture = await createContractFixture({
      loanType: "committed",
      targetAmount: 70_000_000n,
      ltvFloorBps: 11_000,
      collateralTypeOverride: wsolCollateralType,
      oracleFeedSeed,
      oraclePrice,
      borrowerSolAirdropSol: 0.3,
    });

    const borrowerLamportsBefore = BigInt(await connection.getBalance(fixture.borrower.publicKey));

    await program.methods
      .cancelContract()
      .accounts({
        contract: fixture.contractPda,
        operationsFund: fixture.operationsFundPda,
        borrower: fixture.borrower.publicKey,
        contractCollateralAta: fixture.contractCollateralAta,
        borrowerCollateralAta: null,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([fixture.borrower])
      .rpc();

    const contractAfter = await program.account.debtContract.fetch(fixture.contractPda);
    const contractCollateralInfo = await connection.getAccountInfo(fixture.contractCollateralAta);
    const borrowerLamportsAfter = BigInt(await connection.getBalance(fixture.borrower.publicKey));
    expectAnchorEnumVariant(contractAfter.status, "cancelled");
    assert.equal(contractAfter.collateralAmount.toString(), "0");
    assert.isNull(contractCollateralInfo, "wSOL contract ATA should close during cancel");
    assert.isTrue(
      borrowerLamportsAfter + 30_000n >= borrowerLamportsBefore + fixture.collateralAmount,
      "borrower should receive native SOL after wSOL unwrap on cancel",
    );
  });

  it("supports lender USDC refund after cancellation", async function () {
    if (!mockOracleAvailable) return this.skip();
    const oracleSeed = nextOracleSeed();
    const fixture = await createContractFixture({
      loanType: "committed",
      targetAmount: 120_000_000n,
      ltvFloorBps: 11_000,
      oracleFeedSeed: oracleSeed,
      oraclePrice: 250_000_000_000n,
    });
    const lenderPosition = await contributeToContract(fixture, 40_000_000n);

    await program.methods
      .cancelContract()
      .accounts({
        contract: fixture.contractPda,
        operationsFund: fixture.operationsFundPda,
        borrower: fixture.borrower.publicKey,
        contractCollateralAta: fixture.contractCollateralAta,
        borrowerCollateralAta: fixture.borrowerCollateralAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([fixture.borrower])
      .rpc();

    const lenderUsdcBefore = await getAccount(connection, lenderPosition.lenderUsdcAta);
    await program.methods
      .refundLender()
      .accounts({
        contract: fixture.contractPda,
        contribution: lenderPosition.contributionPda,
        lender: lenderPosition.lender.publicKey,
        contractUsdcAccount: fixture.contractUsdcAta,
        lenderUsdcAccount: lenderPosition.lenderUsdcAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([lenderPosition.lender])
      .rpc();

    const contributionAfter = await program.account.lenderContribution.fetch(
      lenderPosition.contributionPda,
    );
    const contractAfter = await program.account.debtContract.fetch(fixture.contractPda);
    const lenderUsdcAfter = await getAccount(connection, lenderPosition.lenderUsdcAta);
    const contractUsdcAfter = await getAccount(connection, fixture.contractUsdcAta);
    assert.equal(contributionAfter.isRefunded, true);
    assert.equal(contractAfter.fundedAmount.toString(), "0");
    assert.equal(
      lenderUsdcAfter.amount.toString(),
      (lenderUsdcBefore.amount + lenderPosition.amount).toString(),
      "lender should receive refunded USDC contribution",
    );
    assert.equal(contractUsdcAfter.amount.toString(), "0");
  });

  it("rejects lender refund while contract is still active", async function () {
    if (!mockOracleAvailable) return this.skip();
    const oracleSeed = nextOracleSeed();
    const fixture = await createContractFixture({
      loanType: "committed",
      targetAmount: 120_000_000n,
      ltvFloorBps: 11_000,
      oracleFeedSeed: oracleSeed,
      oraclePrice: 250_000_000_000n,
    });
    const lenderPosition = await contributeToContract(fixture, 40_000_000n);

    try {
      await program.methods
        .refundLender()
        .accounts({
          contract: fixture.contractPda,
          contribution: lenderPosition.contributionPda,
          lender: lenderPosition.lender.publicKey,
          contractUsdcAccount: fixture.contractUsdcAta,
          lenderUsdcAccount: lenderPosition.lenderUsdcAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([lenderPosition.lender])
        .rpc();
      assert.fail("expected refund_lender on active contract to fail");
    } catch (error) {
      assert.match(parseErrorMessage(error), /ContractNotCancelled/);
    }
  });

  it("rejects refund_lender when signer is not the contribution lender", async function () {
    if (!mockOracleAvailable) return this.skip();
    const oracleSeed = nextOracleSeed();
    const fixture = await createContractFixture({
      loanType: "committed",
      targetAmount: 120_000_000n,
      ltvFloorBps: 11_000,
      oracleFeedSeed: oracleSeed,
      oraclePrice: 250_000_000_000n,
    });
    const lenderPosition = await contributeToContract(fixture, 40_000_000n);
    const attacker = anchor.web3.Keypair.generate();
    await airdropSol(connection, attacker, 0.01);
    const attackerUsdcAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      fixture.usdcMint,
      attacker.publicKey,
    );

    await program.methods
      .cancelContract()
      .accounts({
        contract: fixture.contractPda,
        operationsFund: fixture.operationsFundPda,
        borrower: fixture.borrower.publicKey,
        contractCollateralAta: fixture.contractCollateralAta,
        borrowerCollateralAta: fixture.borrowerCollateralAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([fixture.borrower])
      .rpc();

    try {
      await program.methods
        .refundLender()
        .accounts({
          contract: fixture.contractPda,
          contribution: lenderPosition.contributionPda,
          lender: attacker.publicKey,
          contractUsdcAccount: fixture.contractUsdcAta,
          lenderUsdcAccount: attackerUsdcAta.address,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([attacker])
        .rpc();
      assert.fail("expected non-lender refund_lender call to fail");
    } catch (error) {
      assert.match(parseErrorMessage(error), /UnauthorizedClaim/);
    }
  });

  it("prevents double refund of the same contribution", async function () {
    if (!mockOracleAvailable) return this.skip();
    const oracleSeed = nextOracleSeed();
    const fixture = await createContractFixture({
      loanType: "committed",
      targetAmount: 120_000_000n,
      ltvFloorBps: 11_000,
      oracleFeedSeed: oracleSeed,
      oraclePrice: 250_000_000_000n,
    });
    const lenderPosition = await contributeToContract(fixture, 40_000_000n);

    await program.methods
      .cancelContract()
      .accounts({
        contract: fixture.contractPda,
        operationsFund: fixture.operationsFundPda,
        borrower: fixture.borrower.publicKey,
        contractCollateralAta: fixture.contractCollateralAta,
        borrowerCollateralAta: fixture.borrowerCollateralAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([fixture.borrower])
      .rpc();

    await program.methods
      .refundLender()
      .accounts({
        contract: fixture.contractPda,
        contribution: lenderPosition.contributionPda,
        lender: lenderPosition.lender.publicKey,
        contractUsdcAccount: fixture.contractUsdcAta,
        lenderUsdcAccount: lenderPosition.lenderUsdcAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([lenderPosition.lender])
      .rpc();

    try {
      await program.methods
        .refundLender()
        .accounts({
          contract: fixture.contractPda,
          contribution: lenderPosition.contributionPda,
          lender: lenderPosition.lender.publicKey,
          contractUsdcAccount: fixture.contractUsdcAta,
          lenderUsdcAccount: lenderPosition.lenderUsdcAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([lenderPosition.lender])
        .rpc();
      assert.fail("expected second refund_lender call to fail");
    } catch (error) {
      assert.match(parseErrorMessage(error), /AlreadyRefunded/);
    }
  });

  it("rejects v1-style contract creation with null token accounts", async () => {
    const borrower = anchor.web3.Keypair.generate();
    await airdropSol(connection, borrower, 0.03);

    const contractSeed = nextContractSeed();
    const [contractPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("debt_contract"), borrower.publicKey.toBuffer(), u64ToLeBytes(contractSeed)],
      program.programId,
    );
    const [operationsFundPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("operations_fund"), contractPda.toBuffer()],
      program.programId,
    );

    const targetAmount = new anchor.BN(90_000_000);
    try {
      await program.methods
        .createDebtContract(
          contractSeed,
          14,
          targetAmount,
          new anchor.BN(500),
          30,
          new anchor.BN(55_000_000),
          { committed: {} },
          new anchor.BN(8_000),
          8_000,
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
          contract: contractPda,
          operationsFund: operationsFundPda,
          state: statePda,
          treasury: treasuryPda,
          borrower: borrower.publicKey,
          systemProgram: SystemProgram.programId,
          collateralRegistry: null,
          collateralMint: null,
          borrowerCollateralAta: null,
          contractCollateralAta: null,
          priceFeedAccount: null,
          usdcMint: null,
          contractUsdcAta: null,
          borrowerUsdcAta: null,
          treasuryUsdcAccount: null,
          tokenProgram: null,
          associatedTokenProgram: null,
        })
        .signers([borrower])
        .rpc();
      assert.fail("expected v1-style null token accounts to be rejected");
    } catch (error) {
      assert.match(
        parseErrorMessage(error),
        /MissingTokenAccounts|Account `contract` not provided\./,
      );
    }
  });

  it("rejects v1-style lifecycle with null token accounts (create fails)", async () => {
    const borrower = anchor.web3.Keypair.generate();
    await airdropSol(connection, borrower, 0.03);

    const contractSeed = nextContractSeed();
    const [contractPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("debt_contract"), borrower.publicKey.toBuffer(), u64ToLeBytes(contractSeed)],
      program.programId,
    );
    const [operationsFundPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("operations_fund"), contractPda.toBuffer()],
      program.programId,
    );

    const targetAmount = new anchor.BN(80_000_000);
    try {
      await program.methods
        .createDebtContract(
          contractSeed,
          14,
          targetAmount,
          new anchor.BN(500),
          30,
          new anchor.BN(50_000_000),
          { committed: {} },
          new anchor.BN(8000),
          8000,
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
          contract: contractPda,
          operationsFund: operationsFundPda,
          state: statePda,
          treasury: treasuryPda,
          borrower: borrower.publicKey,
          systemProgram: SystemProgram.programId,
          collateralRegistry: null,
          collateralMint: null,
          borrowerCollateralAta: null,
          contractCollateralAta: null,
          priceFeedAccount: null,
          usdcMint: null,
          contractUsdcAta: null,
          borrowerUsdcAta: null,
          treasuryUsdcAccount: null,
          tokenProgram: null,
          associatedTokenProgram: null,
        })
        .signers([borrower])
        .rpc();
      assert.fail("expected v1-style null token accounts to be rejected");
    } catch (error) {
      assert.match(parseErrorMessage(error), /MissingTokenAccounts|not provided/);
    }
  });

  it("rejects v1-style demand contract creation with null token accounts", async () => {
    const borrower = anchor.web3.Keypair.generate();
    await airdropSol(connection, borrower, 0.03);

    const contractSeed = nextContractSeed();
    const [contractPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("debt_contract"), borrower.publicKey.toBuffer(), u64ToLeBytes(contractSeed)],
      program.programId,
    );
    const [operationsFundPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("operations_fund"), contractPda.toBuffer()],
      program.programId,
    );

    const targetAmount = new anchor.BN(40_000_000);
    try {
      await program.methods
        .createDebtContract(
          contractSeed,
          14,
          targetAmount,
          new anchor.BN(500),
          1,
          new anchor.BN(24_000_000),
          { demand: {} },
          new anchor.BN(8000),
          8000,
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
          contract: contractPda,
          operationsFund: operationsFundPda,
          state: statePda,
          treasury: treasuryPda,
          borrower: borrower.publicKey,
          systemProgram: SystemProgram.programId,
          collateralRegistry: null,
          collateralMint: null,
          borrowerCollateralAta: null,
          contractCollateralAta: null,
          priceFeedAccount: null,
          usdcMint: null,
          contractUsdcAta: null,
          borrowerUsdcAta: null,
          treasuryUsdcAccount: null,
          tokenProgram: null,
          associatedTokenProgram: null,
        })
        .signers([borrower])
        .rpc();
      assert.fail("expected v1-style null token accounts to be rejected");
    } catch (error) {
      assert.match(parseErrorMessage(error), /MissingTokenAccounts|not provided/);
    }
  });
});
