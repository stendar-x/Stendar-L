import * as anchor from "@project-serum/anchor";
import { Program } from "@project-serum/anchor";
import { Stendar } from "../target/types/stendar";
import { expect } from "chai";
import { PublicKey, Keypair, SystemProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, createMint, createAccount, mintTo } from "@solana/spl-token";

describe("stendar", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Stendar as Program<Stendar>;
  const borrower = Keypair.generate();
  const lender1 = Keypair.generate();
  const lender2 = Keypair.generate();
  const debtContract = Keypair.generate();
  let collateralMint: PublicKey;
  let borrowerCollateralAccount: PublicKey;

  before(async () => {
    await provider.connection.requestAirdrop(borrower.publicKey, 10 * anchor.web3.LAMPORTS_PER_SOL);
    await provider.connection.requestAirdrop(lender1.publicKey, 10 * anchor.web3.LAMPORTS_PER_SOL);
    await provider.connection.requestAirdrop(lender2.publicKey, 10 * anchor.web3.LAMPORTS_PER_SOL);
    collateralMint = await createMint(provider.connection, borrower, borrower.publicKey, null, 9);
    borrowerCollateralAccount = await createAccount(provider.connection, borrower, collateralMint, borrower.publicKey);
    await mintTo(provider.connection, borrower, collateralMint, borrowerCollateralAccount, borrower, 1000 * 1e9);
  });

  it("Creates a debt contract", async () => {
    await program.methods
      .createDebtContract(
        new anchor.BN(1000 * 1e9), // principal
        500, // interest_bps (5%)
        12, // term_in_months
        1, // payment_schedule (monthly)
        15000 // min_ltv_bps (150%)
      )
      .accounts({
        debtContract: debtContract.publicKey,
        borrower: borrower.publicKey,
        systemProgram: SystemProgram.programId,
        collateralMint: collateralMint,
      })
      .signers([borrower, debtContract])
      .rpc();
    const contract = await program.account.debtContract.fetch(debtContract.publicKey);
    expect(contract.borrower.toString()).to.equal(borrower.publicKey.toString());
    expect(contract.principal.toNumber()).to.equal(1000 * 1e9);
    expect(contract.interestBps).to.equal(500);
    expect(contract.termInMonths).to.equal(12);
    expect(contract.paymentSchedule).to.equal(1);
    expect(contract.minLtvBps).to.equal(15000);
    expect(contract.status).to.equal(0); // initialized
  });

  it("Funds the contract with multiple lenders", async () => {
    await program.methods
      .fundContract(new anchor.BN(500 * 1e9))
      .accounts({
        debtContract: debtContract.publicKey,
        lender: lender1.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([lender1])
      .rpc();
    await program.methods
      .fundContract(new anchor.BN(500 * 1e9))
      .accounts({
        debtContract: debtContract.publicKey,
        lender: lender2.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([lender2])
      .rpc();
    const contract = await program.account.debtContract.fetch(debtContract.publicKey);
    expect(contract.fundedAmount.toNumber()).to.equal(1000 * 1e9);
    expect(contract.status).to.equal(1); // active
  });

  it("Deposits collateral", async () => {
    await program.methods
      .depositCollateral(new anchor.BN(1500 * 1e9))
      .accounts({
        debtContract: debtContract.publicKey,
        borrower: borrower.publicKey,
        collateralMint: collateralMint,
        borrowerCollateralAccount: borrowerCollateralAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([borrower])
      .rpc();
    const contract = await program.account.debtContract.fetch(debtContract.publicKey);
    expect(contract.collateralAmount.toNumber()).to.equal(1500 * 1e9);
  });

  it("Makes a payment", async () => {
    await program.methods
      .makePayment(new anchor.BN(100 * 1e9))
      .accounts({
        debtContract: debtContract.publicKey,
        borrower: borrower.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([borrower])
      .rpc();
    const contract = await program.account.debtContract.fetch(debtContract.publicKey);
    expect(contract.totalPaid.toNumber()).to.equal(100 * 1e9);
  });

  it("Refinances the contract", async () => {
    await program.methods
      .refinance(400, 24) // new_interest_bps (4%), new_term_in_months (24)
      .accounts({
        debtContract: debtContract.publicKey,
        borrower: borrower.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([borrower])
      .rpc();
    const contract = await program.account.debtContract.fetch(debtContract.publicKey);
    expect(contract.interestBps).to.equal(400);
    expect(contract.termInMonths).to.equal(24);
  });

  it("Liquidates the contract if collateral value drops", async () => {
    // Simulate collateral value drop (e.g., by minting more tokens to devalue)
    await mintTo(provider.connection, borrower, collateralMint, borrowerCollateralAccount, borrower, 1000 * 1e9);
    await program.methods
      .liquidate()
      .accounts({
        debtContract: debtContract.publicKey,
        liquidator: lender1.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([lender1])
      .rpc();
    const contract = await program.account.debtContract.fetch(debtContract.publicKey);
    expect(contract.status).to.equal(3); // defaulted
  });
}); 