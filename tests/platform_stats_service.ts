import { assert } from "chai";
import {
  PlatformStatsService,
  type SolanaReader,
} from "../transparency/platform-stats/platformStatsService";

function createService(contracts: any[], contributions: any[]): PlatformStatsService {
  const reader: SolanaReader = {
    getAllContracts: async () => contracts,
    getAllContributions: async () => contributions,
  };
  return new PlatformStatsService(reader);
}

function bnLike(value: number): { toNumber: () => number } {
  return {
    toNumber: () => value,
  };
}

function overflowingBnLike(value: string): { toNumber: () => number; toString: () => string } {
  return {
    toNumber: () => {
      throw new Error("Number can only safely store up to 53 bits");
    },
    toString: () => value,
  };
}

describe("PlatformStatsService transparency stats", () => {
  it("converts contribution atomic units to USDC and ignores missing values", async () => {
    const service = createService(
      [
        {
          account: {
            status: "Active",
            loan_type: "Demand",
            borrower: "borrower-1",
            funded_amount: 0,
          },
        },
      ],
      [
        {
          account: {
            lender: "lender-1",
            contribution_amount: bnLike(1_500_000),
            total_interest_claimed: bnLike(250_000),
            total_principal_claimed: "1000000",
          },
        },
        {
          account: {
            lender: "PARSING_ERROR",
            contribution_amount: null,
            amount: 2_000_000,
            total_interest_claimed: undefined,
            total_principal_claimed: "not-a-number",
          },
        },
        {
          account: {
            lender: "lender-3",
            contribution_amount: BigInt(3_000_000),
          },
        },
      ],
    );

    const stats = await service.calculatePlatformStats();

    assert.strictEqual(stats.contributions.contributionsCount, 3);
    assert.strictEqual(stats.participants.uniqueLenders, 2);
    assert.strictEqual(stats.participants.uniqueBorrowers, 1);
    assert.strictEqual(stats.participants.borrowerToLenderRatio, 0.5);
    assert.strictEqual(stats.uniqueWallets, 3);
    assert.strictEqual(stats.contributions.totalContributedUSDC, 6.5);
    assert.strictEqual(stats.contributions.averageContributionUSDC, 6.5 / 3);
    assert.strictEqual(stats.contributions.totalInterestClaimedUSDC, 0.25);
    assert.strictEqual(stats.contributions.totalPrincipalClaimedUSDC, 1);
    assert.strictEqual(stats.interest.totalInterestClaimedUSDC, 0.25);
    assert.strictEqual(stats.principal.totalPrincipalClaimedUSDC, 1);
  });

  it("excludes null or missing interest rates but includes explicit zero bps", async () => {
    const service = createService(
      [
        {
          account: {
            status: "Active",
            loan_type: "Demand",
            borrower: "borrower-null-rate",
            target_amount: 1_000_000,
            funded_amount: 500_000,
            interest_rate: null,
          },
        },
        {
          account: {
            status: "Completed",
            loan_type: "Demand",
            borrower: "borrower-missing-rate",
            target_amount: 1_000_000,
            funded_amount: 1_000_000,
            total_principal_paid: 1_000_000,
          },
        },
        {
          account: {
            status: "Active",
            loan_type: "Demand",
            borrower: "borrower-zero-rate",
            target_amount: 1_000_000,
            funded_amount: 250_000,
            interest_rate: 0,
          },
        },
      ],
      [],
    );

    const stats = await service.calculatePlatformStats();
    const nonZeroBucketsTotal = Object.entries(stats.interestRate.buckets)
      .filter(([bucket]) => bucket !== "0-2%")
      .reduce((acc, [, count]) => acc + count, 0);

    assert.strictEqual(stats.interestRate.count, 1);
    assert.strictEqual(stats.interestRate.min, 0);
    assert.strictEqual(stats.interestRate.max, 0);
    assert.strictEqual(stats.interestRate.buckets["0-2%"], 1);
    assert.strictEqual(nonZeroBucketsTotal, 0);
    assert.strictEqual(stats.participants.borrowerToLenderRatio, null);
  });

  it("returns zeroed metrics for empty contracts and contributions", async () => {
    const service = createService([], []);

    const stats = await service.calculatePlatformStats();

    assert.strictEqual(stats.uniqueWallets, 0);
    assert.strictEqual(stats.totalVolume, 0);
    assert.strictEqual(stats.activeContracts, 0);
    assert.strictEqual(stats.outstandingUSDC, 0);
    assert.strictEqual(stats.totalContracts, 0);
    assert.strictEqual(stats.interestRate.count, 0);
    assert.strictEqual(stats.contributions.contributionsCount, 0);
    assert.strictEqual(stats.contributions.totalContributedUSDC, 0);
    assert.strictEqual(stats.contributions.totalInterestClaimedUSDC, 0);
    assert.strictEqual(stats.contributions.totalPrincipalClaimedUSDC, 0);
    assert.strictEqual(stats.contractsByStatus.Unknown, 0);
    assert.strictEqual(stats.volumeByLoanType.Unknown, 0);
    assert.strictEqual(stats.payments.interestPaymentType.Unknown, 0);
  });

  it("keeps outlier histograms reachable and skips missing distribution values", async () => {
    const service = createService(
      [
        {
          account: {
            status: "Active",
            loan_type: "Demand",
            borrower: "borrower-outlier",
            funded_amount: overflowingBnLike("2000000"),
            target_amount: null,
            outstanding_balance: 2_000_000,
            accrued_interest: 0,
            collateral_amount: undefined,
            interest_rate: 15_000,
            ltv_ratio: 25_000,
          },
        },
      ],
      [],
    );

    const stats = await service.calculatePlatformStats();

    assert.strictEqual(stats.totalVolume, 2);
    assert.strictEqual(stats.loanSize.count, 0);
    assert.strictEqual(stats.collateral.averageCollateralUSDC, 0);
    assert.strictEqual(stats.interestRate.count, 1);
    assert.strictEqual(stats.interestRate.buckets["100%+"], 1);
    assert.strictEqual(stats.ltvPercent.count, 1);
    assert.strictEqual(stats.ltvPercent.buckets["200%+"], 1);
    assert.strictEqual(stats.fillRatePercent.count, 0);
  });

  it("filters stale open listings without dropping future BN-like expirations", async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const service = createService(
      [
        {
          account: {
            status: "OpenNotFunded",
            loan_type: "Demand",
            borrower: "expired-borrower",
            target_amount: 1_000_000,
            expires_at: nowSeconds - 10,
          },
        },
        {
          account: {
            status: "OpenPartiallyFunded",
            loan_type: "Committed",
            borrower: "future-borrower",
            target_amount: 2_000_000,
            funded_amount: 1_000_000,
            expires_at: bnLike(nowSeconds + 3_600),
          },
        },
      ],
      [],
    );

    const stats = await service.calculatePlatformStats();

    assert.strictEqual(stats.totalContracts, 1);
    assert.strictEqual(stats.contractsByStatus.OpenNotFunded, 0);
    assert.strictEqual(stats.contractsByStatus.OpenPartiallyFunded, 1);
    assert.strictEqual(stats.participants.uniqueBorrowers, 1);
    assert.strictEqual(stats.totalVolume, 1);
    assert.strictEqual(stats.loanSize.count, 1);
    assert.strictEqual(stats.loanSize.average, 2);
    assert.strictEqual(stats.fillRatePercent.count, 1);
    assert.strictEqual(stats.fillRatePercent.average, 50);
    assert.strictEqual(stats.fillRatePercent.buckets["25-50%"], 1);
  });

  it("normalizes payment configuration and status enum values", async () => {
    const service = createService(
      [
        {
          account: {
            status: 2,
            loan_type: 1,
            borrower: "active-borrower",
            target_amount: 5_000_000,
            funded_amount: 3_000_000,
            outstanding_balance: 2_000_000,
            collateral_amount: 4_000_000,
            interest_payment_type: 0,
            principal_payment_type: 1,
            interest_frequency: 2,
            principal_frequency: null,
          },
        },
      ],
      [],
    );

    const stats = await service.calculatePlatformStats();

    assert.strictEqual(stats.contractsByStatus.Active, 1);
    assert.strictEqual(stats.volumeByLoanType.Committed, 3);
    assert.strictEqual(stats.payments.interestPaymentType.OutstandingBalance, 1);
    assert.strictEqual(stats.payments.principalPaymentType.NoFixedPayment, 1);
    assert.strictEqual(stats.payments.interestFrequency.BiWeekly, 1);
    assert.strictEqual(stats.payments.principalFrequency.None, 1);
  });

  it("computes secondary public transparency metrics", async () => {
    const service = createService(
      [
        {
          account: {
            status: "Completed",
            loan_type: "Demand",
            borrower: "completed-borrower-1",
            total_principal_paid: 1_000_000,
            num_contributions: 3,
          },
        },
        {
          account: {
            status: "Completed",
            loan_type: "Demand",
            borrower: "completed-borrower-2",
            total_principal_paid: 3_000_000,
          },
        },
        {
          account: {
            status: "Liquidated",
            loan_type: "Demand",
            borrower: "liquidated-borrower",
            funded_amount: 2_000_000,
          },
        },
        {
          account: {
            status: "Active",
            loan_type: "Committed",
            borrower: "active-borrower",
            target_amount: 1_000_000,
            funded_amount: 2_000_000,
            outstanding_balance: 2_000_000,
            accrued_interest: 500_000,
            collateral_amount: 4_000_000,
            term_days: 4_000,
            num_contributions: 5,
          },
        },
      ],
      [],
    );

    const stats = await service.calculatePlatformStats();

    assert.strictEqual(stats.liquidations.totalLiquidations, 1);
    assert.closeTo(stats.liquidations.liquidationRatePercent, 100 / 3, 0.000001);
    assert.strictEqual(stats.liquidations.liquidatedVolumeUSDC, 2);
    assert.strictEqual(stats.principal.totalPrincipalPaidUSDC, 4);
    assert.strictEqual(stats.principal.averagePrincipalPaidPerCompletedUSDC, 2);
    assert.strictEqual(stats.interest.totalAccruedInterestActiveUSDC, 0.5);
    assert.strictEqual(stats.collateral.totalCollateralLockedActiveUSDC, 4);
    assert.strictEqual(stats.contributions.averageContributionsPerContract, 4);
    assert.strictEqual(stats.fillRatePercent.buckets["100%+"], 1);
    assert.strictEqual(stats.loanTermDays.buckets["10+ years"], 1);
  });

  it("trims normalized string keys and ignores negative atomic amounts", async () => {
    const service = createService(
      [
        {
          account: {
            status: " Active ",
            loan_type: " Demand ",
            borrower: "trimmed-borrower",
            target_amount: -1_000_000,
            funded_amount: -3_000_000,
            outstanding_balance: -2_000_000,
            collateral_amount: -4_000_000,
            interest_payment_type: " OutstandingBalance ",
            principal_payment_type: " NoFixedPayment ",
            interest_frequency: " Weekly ",
            principal_frequency: " Monthly ",
          },
        },
      ],
      [],
    );

    const stats = await service.calculatePlatformStats();

    assert.strictEqual(stats.contractsByStatus.Active, 1);
    assert.strictEqual(stats.contractsByStatus[" Active "], undefined);
    assert.strictEqual(stats.volumeByLoanType.Demand, 0);
    assert.strictEqual(stats.volumeByLoanType[" Demand "], undefined);
    assert.strictEqual(stats.totalVolume, 0);
    assert.strictEqual(stats.outstandingUSDC, 0);
    assert.strictEqual(stats.loanSize.count, 0);
    assert.strictEqual(stats.collateral.averageCollateralUSDC, 0);
    assert.strictEqual(stats.payments.interestPaymentType.OutstandingBalance, 1);
    assert.strictEqual(stats.payments.principalPaymentType.NoFixedPayment, 1);
    assert.strictEqual(stats.payments.interestFrequency.Weekly, 1);
    assert.strictEqual(stats.payments.principalFrequency.Monthly, 1);
  });

  it("degrades independently when SolanaReader fetch calls fail", async () => {
    const originalConsoleWarn = console.warn;
    const warnMessages: unknown[][] = [];
    console.warn = (...args: unknown[]) => {
      warnMessages.push(args);
    };
    try {
      const contributionOnlyService = new PlatformStatsService({
        getAllContracts: async () => {
          throw new Error("contracts unavailable");
        },
        getAllContributions: async () => [
          {
            account: {
              lender: "fallback-lender",
              contribution_amount: undefined,
              amount: 2_000_000,
            },
          },
        ],
      });
      const contributionOnlyStats = await contributionOnlyService.calculatePlatformStats();

      assert.strictEqual(contributionOnlyStats.totalContracts, 0);
      assert.strictEqual(contributionOnlyStats.contributions.contributionsCount, 1);
      assert.strictEqual(contributionOnlyStats.contributions.totalContributedUSDC, 2);

      const contractOnlyService = new PlatformStatsService({
        getAllContracts: async () => [
          {
            account: {
              status: "Active",
              loan_type: "Demand",
              borrower: "fallback-borrower",
              target_amount: 1_000_000,
              funded_amount: 1_000_000,
            },
          },
        ],
        getAllContributions: async () => {
          throw new Error("contributions unavailable");
        },
      });
      const contractOnlyStats = await contractOnlyService.calculatePlatformStats();

      assert.strictEqual(contractOnlyStats.totalContracts, 1);
      assert.strictEqual(contractOnlyStats.totalVolume, 1);
      assert.strictEqual(contractOnlyStats.contributions.contributionsCount, 0);
    } finally {
      console.warn = originalConsoleWarn;
    }
    assert.strictEqual(warnMessages.length, 2);
  });

  it("skips malformed records without dropping valid stats", async () => {
    const malformedContract = Object.defineProperty({}, "account", {
      get() {
        throw new Error("malformed contract");
      },
    });
    const malformedContribution = Object.defineProperty({}, "account", {
      get() {
        throw new Error("malformed contribution");
      },
    });
    const service = createService(
      [
        malformedContract,
        {
          account: {
            status: "Active",
            loan_type: "Demand",
            borrower: "valid-borrower",
            target_amount: 1_000_000,
            funded_amount: 1_000_000,
          },
        },
      ],
      [
        malformedContribution,
        {
          account: {
            lender: "valid-lender",
            contribution_amount: 1_000_000,
          },
        },
      ],
    );
    const originalConsoleWarn = console.warn;
    const warnMessages: unknown[][] = [];
    console.warn = (...args: unknown[]) => {
      warnMessages.push(args);
    };
    try {
      const stats = await service.calculatePlatformStats();

      assert.strictEqual(stats.totalContracts, 1);
      assert.strictEqual(stats.totalVolume, 1);
      assert.strictEqual(stats.contributions.contributionsCount, 1);
      assert.strictEqual(stats.contributions.totalContributedUSDC, 1);
    } finally {
      console.warn = originalConsoleWarn;
    }
    assert.strictEqual(warnMessages.length, 2);
  });

  it("formats platform stats with a stable locale", async () => {
    const service = createService([], []);
    const stats = await service.calculatePlatformStats();

    const formatted = service.formatPlatformStats({
      ...stats,
      uniqueWallets: 1_234,
      totalVolume: 1_234.5,
      activeContracts: 1_000,
      outstandingUSDC: 12.345,
      totalContracts: 2_000,
    });

    assert.strictEqual(formatted.uniqueWallets, "1,234");
    assert.strictEqual(formatted.totalVolume, "1,234.50 USDC");
    assert.strictEqual(formatted.activeContracts, "1,000");
    assert.strictEqual(formatted.outstandingUSDC, "12.35 USDC");
    assert.strictEqual(formatted.totalContracts, "2,000");
  });

  it("returns formatted platform stats through the convenience method", async () => {
    const service = createService([], []);

    const formatted = await service.getFormattedPlatformStats();

    assert.strictEqual(formatted.uniqueWallets, "0");
    assert.strictEqual(formatted.totalVolume, "0.00 USDC");
    assert.strictEqual(formatted.activeContracts, "0");
    assert.strictEqual(formatted.outstandingUSDC, "0.00 USDC");
    assert.strictEqual(formatted.totalContracts, "0");
  });

  it("returns the full zeroed metrics shape when processing fails", async () => {
    const service = new PlatformStatsService({
      getAllContracts: async () => null as unknown as any[],
      getAllContributions: async () => [],
    });

    const originalConsoleError = console.error;
    const errorMessages: unknown[][] = [];
    console.error = (...args: unknown[]) => {
      errorMessages.push(args);
    };
    let stats: Awaited<ReturnType<PlatformStatsService["calculatePlatformStats"]>> | null = null;
    try {
      stats = await service.calculatePlatformStats();
    } finally {
      console.error = originalConsoleError;
    }

    assert.strictEqual(errorMessages.length, 1);
    if (stats === null) assert.fail("expected calculatePlatformStats to return fallback metrics");
    assert.strictEqual(stats.uniqueWallets, 0);
    assert.strictEqual(stats.totalVolume, 0);
    assert.strictEqual(stats.loanSize.count, 0);
    assert.strictEqual(stats.interest.totalAccruedInterestActiveUSDC, 0);
    assert.strictEqual(stats.liquidations.totalLiquidations, 0);
    assert.strictEqual(stats.principal.totalPrincipalPaidUSDC, 0);
    assert.strictEqual(stats.participants.borrowerToLenderRatio, null);
    assert.strictEqual(stats.collateral.averageCollateralUSDC, 0);
    assert.strictEqual(stats.payments.interestPaymentType.OutstandingBalance, 0);
    assert.strictEqual(stats.payments.principalFrequency.None, 0);
  });
});
