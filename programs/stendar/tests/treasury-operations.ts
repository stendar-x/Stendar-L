import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import type { Stendar } from "../../../target/types/stendar";
import { Stendar } from "../../../target/types/stendar";
import { expect } from "chai";
import { PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";

describe("Treasury Automated Operations", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Stendar as Program<Stendar>;
  
  const authority = Keypair.generate();
  const borrower = Keypair.generate();
  const lender1 = Keypair.generate();
  const lender2 = Keypair.generate();
  
  let statePda: PublicKey;
  let treasuryPda: PublicKey;
  let contractPda: PublicKey;
  let contribution1Pda: PublicKey;
  let contribution2Pda: PublicKey;
  let escrow1Pda: PublicKey;
  let escrow2Pda: PublicKey;
  
  const contractSeed = new anchor.BN(1);

  before(async () => {
    await provider.connection.requestAirdrop(authority.publicKey, 5 * LAMPORTS_PER_SOL);
    await provider.connection.requestAirdrop(borrower.publicKey, 5 * LAMPORTS_PER_SOL);
    await provider.connection.requestAirdrop(lender1.publicKey, 5 * LAMPORTS_PER_SOL);
    await provider.connection.requestAirdrop(lender2.publicKey, 5 * LAMPORTS_PER_SOL);
    await new Promise(resolve => setTimeout(resolve, 1000));

    [statePda] = PublicKey.findProgramAddressSync([Buffer.from("global_state")], program.programId);
    [treasuryPda] = PublicKey.findProgramAddressSync([Buffer.from("treasury")], program.programId);
    [contractPda] = PublicKey.findProgramAddressSync([Buffer.from("debt_contract"), borrower.publicKey.toBuffer(), contractSeed.toArrayLike(Buffer, "le", 8)], program.programId);
    [contribution1Pda] = PublicKey.findProgramAddressSync([Buffer.from("contribution"), contractPda.toBuffer(), lender1.publicKey.toBuffer()], program.programId);
    [contribution2Pda] = PublicKey.findProgramAddressSync([Buffer.from("contribution"), contractPda.toBuffer(), lender2.publicKey.toBuffer()], program.programId);
    [escrow1Pda] = PublicKey.findProgramAddressSync([Buffer.from("escrow"), contractPda.toBuffer(), lender1.publicKey.toBuffer()], program.programId);
    [escrow2Pda] = PublicKey.findProgramAddressSync([Buffer.from("escrow"), contractPda.toBuffer(), lender2.publicKey.toBuffer()], program.programId);

    await setupTestEnvironment();
  });

  async function setupTestEnvironment() {
    await program.methods.initialize().accounts({
      state: statePda,
      authority: authority.publicKey,
      systemProgram: SystemProgram.programId,
    } as any).signers([authority]).rpc();

    await program.methods.initializeTreasury().accounts({
      treasury: treasuryPda,
      state: statePda,
      authority: authority.publicKey,
      systemProgram: SystemProgram.programId,
    } as any).signers([authority]).rpc();

    await program.methods.createDebtContract(
      contractSeed,
      new anchor.BN(1000 * LAMPORTS_PER_SOL),
      new anchor.BN(500),
      365,
      new anchor.BN(1500 * LAMPORTS_PER_SOL),
      { demand: {} },
      new anchor.BN(15000),
      { outstandingBalance: {} },
      { noFixedPayment: {} },
      { monthly: {} },
      null
    ).accounts({
      contract: contractPda,
      state: statePda,
      treasury: treasuryPda,
      borrower: borrower.publicKey,
      systemProgram: SystemProgram.programId,
    } as any).signers([borrower]).rpc();

    await program.methods.contributeToContract(new anchor.BN(600 * LAMPORTS_PER_SOL)).accounts({
      contract: contractPda,
      contribution: contribution1Pda,
      escrow: escrow1Pda,
      lender: lender1.publicKey,
      borrower: borrower.publicKey,
      systemProgram: SystemProgram.programId,
    } as any).signers([lender1]).rpc();

    await program.methods.contributeToContract(new anchor.BN(400 * LAMPORTS_PER_SOL)).accounts({
      contract: contractPda,
      contribution: contribution2Pda,
      escrow: escrow2Pda,
      lender: lender2.publicKey,
      borrower: borrower.publicKey,
      systemProgram: SystemProgram.programId,
    } as any).signers([lender2]).rpc();

    await program.methods.makePayment(new anchor.BN(100 * LAMPORTS_PER_SOL)).accounts({
      contract: contractPda,
      state: statePda,
      borrower: borrower.publicKey,
      systemProgram: SystemProgram.programId,
    } as any).signers([borrower]).rpc();
  }

  describe("Interest & Principal Transfers", () => {
    it("Processes automated interest distribution", async () => {
      const lender1BalanceBefore = await provider.connection.getBalance(lender1.publicKey);
      const lender2BalanceBefore = await provider.connection.getBalance(lender2.publicKey);
      const treasuryBalanceBefore = await provider.connection.getBalance(treasuryPda);

      const lenderAccounts = [
        { pubkey: contribution1Pda, isSigner: false, isWritable: false },
        { pubkey: escrow1Pda, isSigner: false, isWritable: true },
        { pubkey: lender1.publicKey, isSigner: false, isWritable: true },
        { pubkey: contribution2Pda, isSigner: false, isWritable: false },
        { pubkey: escrow2Pda, isSigner: false, isWritable: true },
        { pubkey: lender2.publicKey, isSigner: false, isWritable: true },
      ];

      await program.methods.automatedInterestTransfer().accounts({
        contract: contractPda,
        treasury: treasuryPda,
        authority: authority.publicKey,
        systemProgram: SystemProgram.programId,
      } as any).remainingAccounts(lenderAccounts).signers([authority]).rpc();

      const lender1BalanceAfter = await provider.connection.getBalance(lender1.publicKey);
      const lender2BalanceAfter = await provider.connection.getBalance(lender2.publicKey);
      const treasuryBalanceAfter = await provider.connection.getBalance(treasuryPda);

      expect(lender1BalanceAfter).to.be.greaterThan(lender1BalanceBefore);
      expect(lender2BalanceAfter).to.be.greaterThan(lender2BalanceBefore);
      expect(treasuryBalanceAfter).to.be.lessThan(treasuryBalanceBefore);

      // Verify proportional distribution (60% to lender1, 40% to lender2)
      const lender1Gain = lender1BalanceAfter - lender1BalanceBefore;
      const lender2Gain = lender2BalanceAfter - lender2BalanceBefore;
      const ratio = lender1Gain / lender2Gain;
      expect(ratio).to.be.approximately(1.5, 0.1); // 60/40 = 1.5

      const treasury = await program.account.treasury.fetch(treasuryPda);
      expect(treasury.automatedOperations.toNumber()).to.equal(1);
      expect(treasury.totalTxCosts.toNumber()).to.be.greaterThan(0);
    });

    it("Processes automated principal distribution", async () => {
      // Make another payment to ensure principal is available
      await program.methods.makePayment(new anchor.BN(200 * LAMPORTS_PER_SOL)).accounts({
        contract: contractPda,
        state: statePda,
        borrower: borrower.publicKey,
        systemProgram: SystemProgram.programId,
      } as any).signers([borrower]).rpc();

      const lender1BalanceBefore = await provider.connection.getBalance(lender1.publicKey);
      const lender2BalanceBefore = await provider.connection.getBalance(lender2.publicKey);

      const lenderAccounts = [
        { pubkey: contribution1Pda, isSigner: false, isWritable: false },
        { pubkey: escrow1Pda, isSigner: false, isWritable: true },
        { pubkey: lender1.publicKey, isSigner: false, isWritable: true },
        { pubkey: contribution2Pda, isSigner: false, isWritable: false },
        { pubkey: escrow2Pda, isSigner: false, isWritable: true },
        { pubkey: lender2.publicKey, isSigner: false, isWritable: true },
      ];

      await program.methods.automatedPrincipalTransfer().accounts({
        contract: contractPda,
        treasury: treasuryPda,
        authority: authority.publicKey,
        systemProgram: SystemProgram.programId,
      } as any).remainingAccounts(lenderAccounts).signers([authority]).rpc();

      const lender1BalanceAfter = await provider.connection.getBalance(lender1.publicKey);
      const lender2BalanceAfter = await provider.connection.getBalance(lender2.publicKey);

      expect(lender1BalanceAfter).to.be.greaterThan(lender1BalanceBefore);
      expect(lender2BalanceAfter).to.be.greaterThan(lender2BalanceBefore);

      const treasury = await program.account.treasury.fetch(treasuryPda);
      expect(treasury.automatedOperations.toNumber()).to.equal(2);
    });
  });

  describe("Access Control & Error Handling", () => {
    it("Prevents unauthorized automated operations", async () => {
      const unauthorizedUser = Keypair.generate();
      await provider.connection.requestAirdrop(unauthorizedUser.publicKey, LAMPORTS_PER_SOL);

      try {
        await program.methods.automatedInterestTransfer().accounts({
          contract: contractPda,
          treasury: treasuryPda,
          authority: unauthorizedUser.publicKey,
          systemProgram: SystemProgram.programId,
        } as any).signers([unauthorizedUser]).rpc();
        
        expect.fail("Should have thrown an error");
      } catch (error) {
        expect(error.message).to.include("unauthorized");
      }
    });

    it("Maintains treasury state consistency", async () => {
      const treasury = await program.account.treasury.fetch(treasuryPda);
      
      expect(treasury.authority.toString()).to.equal(authority.publicKey.toString());
      expect(treasury.automatedOperations.toNumber()).to.be.greaterThan(0);
      expect(treasury.totalTxCosts.toNumber()).to.be.greaterThan(0);
      expect(treasury.totalFeesCollected.toNumber()).to.be.greaterThan(0);
    });
  });

  describe("Performance & Efficiency", () => {
    it("Handles batch operations efficiently", async () => {
      const treasury = await program.account.treasury.fetch(treasuryPda);

      expect(treasury.automatedOperations.toNumber()).to.be.greaterThan(0);
      expect(treasury.totalTxCosts.toNumber()).to.be.greaterThan(0);
    });
  });
}); 