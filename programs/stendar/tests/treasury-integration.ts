import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Stendar } from "../../../target/types/stendar";
import { expect } from "chai";
import { PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";

describe("Treasury Integration Tests", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Stendar as Program<Stendar>;
  
  // Test accounts
  const authority = Keypair.generate();
  const borrower = Keypair.generate();
  const lender1 = Keypair.generate();
  const lender2 = Keypair.generate();
  
  // PDAs
  let statePda: PublicKey;
  let treasuryPda: PublicKey;
  let contractPda: PublicKey;
  let contribution1Pda: PublicKey;
  let contribution2Pda: PublicKey;
  let escrow1Pda: PublicKey;
  let escrow2Pda: PublicKey;
  
  const contractSeed = new anchor.BN(1);
  const LISTING_FEE = 0.1 * LAMPORTS_PER_SOL;

  before(async () => {
    // Airdrop SOL to test accounts
    await provider.connection.requestAirdrop(authority.publicKey, 5 * LAMPORTS_PER_SOL);
    await provider.connection.requestAirdrop(borrower.publicKey, 5 * LAMPORTS_PER_SOL);
    await provider.connection.requestAirdrop(lender1.publicKey, 5 * LAMPORTS_PER_SOL);
    await provider.connection.requestAirdrop(lender2.publicKey, 5 * LAMPORTS_PER_SOL);

    // Wait for airdrops
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Derive PDAs
    [statePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("global_state")],
      program.programId
    );

    [treasuryPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("treasury")],
      program.programId
    );

    [contractPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("debt_contract"), borrower.publicKey.toBuffer(), contractSeed.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    [contribution1Pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("contribution"), contractPda.toBuffer(), lender1.publicKey.toBuffer()],
      program.programId
    );

    [contribution2Pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("contribution"), contractPda.toBuffer(), lender2.publicKey.toBuffer()],
      program.programId
    );

    [escrow1Pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), contractPda.toBuffer(), lender1.publicKey.toBuffer()],
      program.programId
    );

    [escrow2Pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), contractPda.toBuffer(), lender2.publicKey.toBuffer()],
      program.programId
    );
  });

  describe("Platform Setup", () => {
    it("Initializes platform state and treasury", async () => {
      await program.methods
        .initialize()
        .accounts({
          state: statePda,
          authority: authority.publicKey,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([authority])
        .rpc();

      await program.methods
        .initializeTreasury()
        .accounts({
          treasury: treasuryPda,
          state: statePda,
          authority: authority.publicKey,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([authority])
        .rpc();

      const state = await program.account.state.fetch(statePda);
      const treasury = await program.account.treasury.fetch(treasuryPda);
      
      expect(state.authority.toString()).to.equal(authority.publicKey.toString());
      expect(treasury.authority.toString()).to.equal(authority.publicKey.toString());
      expect(treasury.totalFeesCollected.toNumber()).to.equal(0);
    });
  });

  describe("Contract Creation with Fee Collection", () => {
    it("Creates contract and collects listing fee", async () => {
      const treasuryBalanceBefore = await provider.connection.getBalance(treasuryPda);

      await program.methods
        .createDebtContract(
          contractSeed,
          new anchor.BN(1000 * LAMPORTS_PER_SOL),
          new anchor.BN(500), // 5% interest
          365,
          new anchor.BN(1500 * LAMPORTS_PER_SOL),
          { demand: {} },
          new anchor.BN(15000), // Convert to BN - this is ltvRatio
          { outstandingBalance: {} },
          { noFixedPayment: {} },
          { monthly: {} },
          null
        )
        .accounts({
          contract: contractPda,
          state: statePda,
          treasury: treasuryPda,
          borrower: borrower.publicKey,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([borrower])
        .rpc();

      const treasuryBalanceAfter = await provider.connection.getBalance(treasuryPda);
      const treasury = await program.account.treasury.fetch(treasuryPda);

      expect(treasuryBalanceAfter - treasuryBalanceBefore).to.equal(LISTING_FEE);
      expect(treasury.totalFeesCollected.toNumber()).to.equal(LISTING_FEE);
    });
  });

  describe("Contract Funding Flow", () => {
    it("Funds contract with multiple lenders", async () => {
      await program.methods
        .contributeToContract(new anchor.BN(600 * LAMPORTS_PER_SOL))
        .accounts({
          contract: contractPda,
          contribution: contribution1Pda,
          escrow: escrow1Pda,
          lender: lender1.publicKey,
          borrower: borrower.publicKey,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([lender1])
        .rpc();

      await program.methods
        .contributeToContract(new anchor.BN(400 * LAMPORTS_PER_SOL))
        .accounts({
          contract: contractPda,
          contribution: contribution2Pda,
          escrow: escrow2Pda,
          lender: lender2.publicKey,
          borrower: borrower.publicKey,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([lender2])
        .rpc();

      const contract = await program.account.debtContract.fetch(contractPda);
      expect(contract.fundedAmount.toNumber()).to.equal(1000 * LAMPORTS_PER_SOL);
      expect(contract.status).to.deep.equal({ funded: {} });
    });

    it("Makes payment to generate funds for distribution", async () => {
      await program.methods
        .makePayment(new anchor.BN(100 * LAMPORTS_PER_SOL))
        .accounts({
          contract: contractPda,
          state: statePda,
          borrower: borrower.publicKey,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([borrower])
        .rpc();

      const contract = await program.account.debtContract.fetch(contractPda);
      expect(contract.totalPrincipalPaid.toNumber()).to.be.greaterThan(0);
    });
  });

  describe("Complete Integration Flow", () => {
    it("Verifies end-to-end lending cycle with treasury", async () => {
      // Verify treasury has collected fees
      const treasury = await program.account.treasury.fetch(treasuryPda);
      expect(treasury.totalFeesCollected.toNumber()).to.equal(LISTING_FEE);
      
      // Verify contract is properly funded
      const contract = await program.account.debtContract.fetch(contractPda);
      expect(contract.status).to.deep.equal({ funded: {} });
      expect(contract.fundedAmount.toNumber()).to.equal(1000 * LAMPORTS_PER_SOL);
      
      // Verify lender contributions
      const contribution1 = await program.account.lenderContribution.fetch(contribution1Pda);
      const contribution2 = await program.account.lenderContribution.fetch(contribution2Pda);
      expect(contribution1.amount.toNumber()).to.equal(600 * LAMPORTS_PER_SOL);
      expect(contribution2.amount.toNumber()).to.equal(400 * LAMPORTS_PER_SOL);

      // Verify escrow accounts exist
      const escrow1 = await program.account.lenderEscrow.fetch(escrow1Pda);
      const escrow2 = await program.account.lenderEscrow.fetch(escrow2Pda);
      expect(escrow1.contract.toString()).to.equal(contractPda.toString());
      expect(escrow2.contract.toString()).to.equal(contractPda.toString());

      console.log("✅ Complete treasury integration flow verified");
    });
  });

  describe("Treasury Statistics Tracking", () => {
    it("Tracks treasury metrics correctly", async () => {
      const treasury = await program.account.treasury.fetch(treasuryPda);
      
      expect(treasury.totalFeesCollected.toNumber()).to.be.greaterThan(0);
      expect(treasury.createdAt.toNumber()).to.be.greaterThan(0);
      expect(treasury.authority.toString()).to.equal(authority.publicKey.toString());
      
      // Initial state - no automated operations yet
      expect(treasury.automatedOperations.toNumber()).to.equal(0);
      expect(treasury.totalTxCosts.toNumber()).to.equal(0);
    });
  });
}); 