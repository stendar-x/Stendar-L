import { SolanaService } from './solanaService';

// TypeScript interfaces for platform statistics
interface PlatformMetrics {
  uniqueWallets: number;
  totalVolume: number;
  activeContracts: number;
  outstandingUSDC: number;
  totalContracts: number;
  contractsByStatus: Record<string, number>;
  volumeByLoanType: Record<string, number>;

  loanSize: HistogramMetrics;
  interestRate: HistogramMetrics;
  loanTermDays: HistogramMetrics;
  ltvPercent: HistogramMetrics;
  fillRatePercent: HistogramMetrics;

  interest: InterestTotalsMetrics;
  liquidations: LiquidationMetrics;
  principal: PrincipalMetrics;
  participants: ParticipantMetrics;
  contributions: ContributionMetrics;
  collateral: CollateralMetrics;
  payments: PaymentConfigurationMetrics;
}

interface FormattedPlatformMetrics {
  uniqueWallets: string;
  totalVolume: string;
  activeContracts: string;
  outstandingUSDC: string;
  totalContracts: string;
  contractsByStatus: Record<string, number>;
  volumeByLoanType: Record<string, number>;
}

interface SummaryMetrics {
  count: number;
  average: number;
  median: number;
  min: number;
  max: number;
}

interface HistogramMetrics extends SummaryMetrics {
  buckets: Record<string, number>;
}

interface LiquidationMetrics {
  totalLiquidations: number;
  liquidationRatePercent: number;
  liquidatedVolumeUSDC: number;
}

interface InterestTotalsMetrics {
  totalAccruedInterestActiveUSDC: number;
  totalInterestClaimedUSDC: number;
}

interface PrincipalMetrics {
  totalPrincipalPaidUSDC: number;
  averagePrincipalPaidPerCompletedUSDC: number;
  totalPrincipalClaimedUSDC: number;
}

interface ParticipantMetrics {
  uniqueBorrowers: number;
  uniqueLenders: number;
  borrowerToLenderRatio: number | null;
}

interface ContributionMetrics {
  contributionsCount: number;
  totalContributedUSDC: number;
  averageContributionUSDC: number;
  averageContributionsPerContract: number;
  totalInterestClaimedUSDC: number;
  totalPrincipalClaimedUSDC: number;
}

interface CollateralMetrics {
  totalCollateralLockedActiveUSDC: number;
  averageCollateralUSDC: number;
  medianCollateralUSDC: number;
  minCollateralUSDC: number;
  maxCollateralUSDC: number;
}

interface PaymentConfigurationMetrics {
  interestPaymentType: Record<string, number>;
  principalPaymentType: Record<string, number>;
  interestFrequency: Record<string, number>;
  principalFrequency: Record<string, number>;
}

interface PlatformStatsCalculation {
  uniqueWalletAddresses: Set<string>;
  uniqueBorrowers: Set<string>;
  uniqueLenders: Set<string>;
  totalVolumeAmount: number;
  activeContractsCount: number;
  outstandingUSDCAmount: number;
  contractsByStatus: Record<string, number>;
  volumeByLoanType: Record<string, number>;

  loanSizeValuesUSDC: number[];
  interestRateValuesPercent: number[];
  loanTermDaysValues: number[];
  ltvPercentValues: number[];
  fillRatePercentValues: number[];
  collateralValuesUSDC: number[];

  completedContractsCount: number;
  liquidatedContractsCount: number;
  liquidatedVolumeUSDC: number;
  totalAccruedInterestActiveUSDC: number;
  totalPrincipalPaidUSDC: number;
  completedPrincipalPaidUSDC: number;

  totalContributedUSDC: number;
  contributionValuesUSDC: number[];
  totalInterestClaimedUSDC: number;
  totalPrincipalClaimedUSDC: number;

  totalNumContributions: number;
  contractsWithNumContributions: number;
  totalCollateralLockedActiveUSDC: number;

  paymentConfiguration: PaymentConfigurationMetrics;
}

const DEFAULT_CONTRACT_STATUS_KEYS = [
  'OpenNotFunded',
  'OpenPartiallyFunded',
  'Active',
  'PendingRecall',
  'Completed',
  'Cancelled',
  'Liquidated',
] as const;

const DEFAULT_LOAN_TYPE_KEYS = ['Demand', 'Committed'] as const;

const DEFAULT_INTEREST_PAYMENT_TYPE_KEYS = ['OutstandingBalance', 'CollateralTransfer'] as const;
const DEFAULT_PRINCIPAL_PAYMENT_TYPE_KEYS = ['CollateralDeduction', 'NoFixedPayment'] as const;
const DEFAULT_PAYMENT_FREQUENCY_KEYS = ['Daily', 'Weekly', 'BiWeekly', 'Monthly'] as const;
const DEFAULT_PRINCIPAL_FREQUENCY_KEYS = [...DEFAULT_PAYMENT_FREQUENCY_KEYS, 'None'] as const;

const LOAN_SIZE_BUCKETS_USDC: readonly HistogramBucket[] = [
  { label: '0-1 USDC', upperBoundInclusive: 1 },
  { label: '1-5 USDC', upperBoundInclusive: 5 },
  { label: '5-10 USDC', upperBoundInclusive: 10 },
  { label: '10-25 USDC', upperBoundInclusive: 25 },
  { label: '25-50 USDC', upperBoundInclusive: 50 },
  { label: '50-100 USDC', upperBoundInclusive: 100 },
  { label: '100-250 USDC', upperBoundInclusive: 250 },
  { label: '250-500 USDC', upperBoundInclusive: 500 },
  { label: '500-1000 USDC', upperBoundInclusive: 1000 },
  { label: '1000+ USDC', upperBoundInclusive: Number.POSITIVE_INFINITY },
] as const;

const INTEREST_RATE_BUCKETS_PERCENT: readonly HistogramBucket[] = [
  { label: '0-2%', upperBoundInclusive: 2 },
  { label: '2-5%', upperBoundInclusive: 5 },
  { label: '5-10%', upperBoundInclusive: 10 },
  { label: '10-15%', upperBoundInclusive: 15 },
  { label: '15-20%', upperBoundInclusive: 20 },
  { label: '20-30%', upperBoundInclusive: 30 },
  { label: '30-50%', upperBoundInclusive: 50 },
  { label: '50-100%', upperBoundInclusive: 100 },
  { label: '100%+', upperBoundInclusive: Number.POSITIVE_INFINITY },
] as const;

const TERM_DAYS_BUCKETS: readonly HistogramBucket[] = [
  { label: '0-7 days', upperBoundInclusive: 7 },
  { label: '8-30 days', upperBoundInclusive: 30 },
  { label: '31-90 days', upperBoundInclusive: 90 },
  { label: '91-180 days', upperBoundInclusive: 180 },
  { label: '181-365 days', upperBoundInclusive: 365 },
  { label: '1-2 years', upperBoundInclusive: 730 },
  { label: '2-5 years', upperBoundInclusive: 1825 },
  { label: '5-10 years', upperBoundInclusive: 3650 },
  { label: '10+ years', upperBoundInclusive: Number.POSITIVE_INFINITY },
] as const;

const LTV_BUCKETS_PERCENT: readonly HistogramBucket[] = [
  { label: '0-10%', upperBoundInclusive: 10 },
  { label: '10-20%', upperBoundInclusive: 20 },
  { label: '20-40%', upperBoundInclusive: 40 },
  { label: '40-60%', upperBoundInclusive: 60 },
  { label: '60-80%', upperBoundInclusive: 80 },
  { label: '80-100%', upperBoundInclusive: 100 },
  { label: '100-120%', upperBoundInclusive: 120 },
  { label: '120-150%', upperBoundInclusive: 150 },
  { label: '150-200%', upperBoundInclusive: 200 },
  { label: '200%+', upperBoundInclusive: Number.POSITIVE_INFINITY },
] as const;

const FILL_RATE_BUCKETS_PERCENT: readonly HistogramBucket[] = [
  { label: '0-25%', upperBoundInclusive: 25 },
  { label: '25-50%', upperBoundInclusive: 50 },
  { label: '50-75%', upperBoundInclusive: 75 },
  { label: '75-90%', upperBoundInclusive: 90 },
  { label: '90-99%', upperBoundInclusive: 99 },
  { label: '99-100%', upperBoundInclusive: 100 },
  { label: '100%+', upperBoundInclusive: Number.POSITIVE_INFINITY },
] as const;

class PlatformStatsService {
  private solanaService: SolanaService;

  constructor(solanaService: SolanaService) {
    this.solanaService = solanaService;
  }

  // Calculate real platform statistics from blockchain data
  public async calculatePlatformStats(): Promise<PlatformMetrics> {
    console.log('🔍 Starting platform stats calculation...');
    
    try {
      // Get all contracts and contributions from blockchain
      console.log('📊 Fetching contracts and contributions from blockchain...');
      
      // Handle contracts safely
      let contracts: any[] = [];
      try {
        contracts = await this.solanaService.getAllContracts();
        console.log(`📋 Found ${contracts.length} contracts`);
      } catch (error) {
        console.warn('⚠️ Failed to fetch contracts for platform stats:', error);
        contracts = [];
      }
      
      // Handle contributions safely
      let contributions: any[] = [];
      try {
        contributions = await this.solanaService.getAllContributions();
        console.log(`📋 Found ${contributions.length} contributions`);
      } catch (error) {
        console.warn('⚠️ Failed to fetch contributions for platform stats:', error);
        contributions = [];
      }

      const calculation: PlatformStatsCalculation = {
        uniqueWalletAddresses: new Set<string>(),
        uniqueBorrowers: new Set<string>(),
        uniqueLenders: new Set<string>(),
        totalVolumeAmount: 0,
        activeContractsCount: 0,
        outstandingUSDCAmount: 0,
        contractsByStatus: createCountMap(DEFAULT_CONTRACT_STATUS_KEYS),
        volumeByLoanType: createCountMap(DEFAULT_LOAN_TYPE_KEYS),

        loanSizeValuesUSDC: [],
        interestRateValuesPercent: [],
        loanTermDaysValues: [],
        ltvPercentValues: [],
        fillRatePercentValues: [],
        collateralValuesUSDC: [],

        completedContractsCount: 0,
        liquidatedContractsCount: 0,
        liquidatedVolumeUSDC: 0,
        totalAccruedInterestActiveUSDC: 0,
        totalPrincipalPaidUSDC: 0,
        completedPrincipalPaidUSDC: 0,

        totalContributedUSDC: 0,
        contributionValuesUSDC: [],
        totalInterestClaimedUSDC: 0,
        totalPrincipalClaimedUSDC: 0,

        totalNumContributions: 0,
        contractsWithNumContributions: 0,
        totalCollateralLockedActiveUSDC: 0,

        paymentConfiguration: {
          interestPaymentType: createCountMap(DEFAULT_INTEREST_PAYMENT_TYPE_KEYS),
          principalPaymentType: createCountMap(DEFAULT_PRINCIPAL_PAYMENT_TYPE_KEYS),
          interestFrequency: createCountMap(DEFAULT_PAYMENT_FREQUENCY_KEYS),
          principalFrequency: createCountMap(DEFAULT_PRINCIPAL_FREQUENCY_KEYS),
        },
      };

      const eligibleContracts = contracts.filter(
        (c: any) => !this.isStaleOpenListing(c.account)
      );

      // Process contracts for metrics
      if (eligibleContracts.length > 0) {
        this.processContracts(eligibleContracts, calculation);
      }

      // Process contributions for unique lenders
      if (contributions.length > 0) {
        this.processContributions(contributions, calculation);
      }

      const loanSize = calculateHistogramMetrics(calculation.loanSizeValuesUSDC, LOAN_SIZE_BUCKETS_USDC);
      const interestRate = calculateHistogramMetrics(calculation.interestRateValuesPercent, INTEREST_RATE_BUCKETS_PERCENT);
      const loanTermDays = calculateHistogramMetrics(calculation.loanTermDaysValues, TERM_DAYS_BUCKETS);
      const ltvPercent = calculateHistogramMetrics(calculation.ltvPercentValues, LTV_BUCKETS_PERCENT);
      const fillRatePercent = calculateHistogramMetrics(calculation.fillRatePercentValues, FILL_RATE_BUCKETS_PERCENT);

      const collateralSummary = calculateSummaryMetrics(calculation.collateralValuesUSDC);
      const collateral: CollateralMetrics = {
        totalCollateralLockedActiveUSDC: calculation.totalCollateralLockedActiveUSDC,
        averageCollateralUSDC: collateralSummary.average,
        medianCollateralUSDC: collateralSummary.median,
        minCollateralUSDC: collateralSummary.min,
        maxCollateralUSDC: collateralSummary.max,
      };

      const liquidationDenominator = calculation.completedContractsCount + calculation.liquidatedContractsCount;
      const liquidationRatePercent = liquidationDenominator > 0
        ? (calculation.liquidatedContractsCount / liquidationDenominator) * 100
        : 0;

      const liquidations: LiquidationMetrics = {
        totalLiquidations: calculation.liquidatedContractsCount,
        liquidationRatePercent,
        liquidatedVolumeUSDC: calculation.liquidatedVolumeUSDC,
      };

      const averagePrincipalPaidPerCompletedUSDC = calculation.completedContractsCount > 0
        ? calculation.completedPrincipalPaidUSDC / calculation.completedContractsCount
        : 0;

      const principal: PrincipalMetrics = {
        totalPrincipalPaidUSDC: calculation.totalPrincipalPaidUSDC,
        averagePrincipalPaidPerCompletedUSDC,
        totalPrincipalClaimedUSDC: calculation.totalPrincipalClaimedUSDC,
      };

      const uniqueBorrowers = calculation.uniqueBorrowers.size;
      const uniqueLenders = calculation.uniqueLenders.size;
      const participants: ParticipantMetrics = {
        uniqueBorrowers,
        uniqueLenders,
        borrowerToLenderRatio: uniqueLenders > 0 ? uniqueBorrowers / uniqueLenders : null,
      };

      const averageContributionUSDC = calculation.contributionValuesUSDC.length > 0
        ? calculation.totalContributedUSDC / calculation.contributionValuesUSDC.length
        : 0;

      const averageContributionsPerContract = calculation.contractsWithNumContributions > 0
        ? calculation.totalNumContributions / calculation.contractsWithNumContributions
        : 0;

      const contributionsMetrics: ContributionMetrics = {
        contributionsCount: calculation.contributionValuesUSDC.length,
        totalContributedUSDC: calculation.totalContributedUSDC,
        averageContributionUSDC,
        averageContributionsPerContract,
        totalInterestClaimedUSDC: calculation.totalInterestClaimedUSDC,
        totalPrincipalClaimedUSDC: calculation.totalPrincipalClaimedUSDC,
      };

      const interest: InterestTotalsMetrics = {
        totalAccruedInterestActiveUSDC: calculation.totalAccruedInterestActiveUSDC,
        totalInterestClaimedUSDC: calculation.totalInterestClaimedUSDC,
      };

      const result = {
        uniqueWallets: calculation.uniqueWalletAddresses.size,
        totalVolume: calculation.totalVolumeAmount,
        activeContracts: calculation.activeContractsCount,
        outstandingUSDC: calculation.outstandingUSDCAmount,
        totalContracts: eligibleContracts.length,
        contractsByStatus: calculation.contractsByStatus,
        volumeByLoanType: calculation.volumeByLoanType,
        loanSize,
        interestRate,
        loanTermDays,
        ltvPercent,
        fillRatePercent,
        interest,
        liquidations,
        principal,
        participants,
        contributions: contributionsMetrics,
        collateral,
        payments: calculation.paymentConfiguration,
      };

      console.log('✅ Platform stats calculated successfully:', result);
      return result;
    } catch (error) {
      console.error('❌ Error in platform stats calculation:', error);
      // Return default stats instead of throwing
      return {
        uniqueWallets: 0,
        totalVolume: 0,
        activeContracts: 0,
        outstandingUSDC: 0,
        totalContracts: 0,
        contractsByStatus: createCountMap(DEFAULT_CONTRACT_STATUS_KEYS),
        volumeByLoanType: createCountMap(DEFAULT_LOAN_TYPE_KEYS),
        loanSize: calculateHistogramMetrics([], LOAN_SIZE_BUCKETS_USDC),
        interestRate: calculateHistogramMetrics([], INTEREST_RATE_BUCKETS_PERCENT),
        loanTermDays: calculateHistogramMetrics([], TERM_DAYS_BUCKETS),
        ltvPercent: calculateHistogramMetrics([], LTV_BUCKETS_PERCENT),
        fillRatePercent: calculateHistogramMetrics([], FILL_RATE_BUCKETS_PERCENT),
        interest: {
          totalAccruedInterestActiveUSDC: 0,
          totalInterestClaimedUSDC: 0,
        },
        liquidations: {
          totalLiquidations: 0,
          liquidationRatePercent: 0,
          liquidatedVolumeUSDC: 0,
        },
        principal: {
          totalPrincipalPaidUSDC: 0,
          averagePrincipalPaidPerCompletedUSDC: 0,
          totalPrincipalClaimedUSDC: 0,
        },
        participants: {
          uniqueBorrowers: 0,
          uniqueLenders: 0,
          borrowerToLenderRatio: null,
        },
        contributions: {
          contributionsCount: 0,
          totalContributedUSDC: 0,
          averageContributionUSDC: 0,
          averageContributionsPerContract: 0,
          totalInterestClaimedUSDC: 0,
          totalPrincipalClaimedUSDC: 0,
        },
        collateral: {
          totalCollateralLockedActiveUSDC: 0,
          averageCollateralUSDC: 0,
          medianCollateralUSDC: 0,
          minCollateralUSDC: 0,
          maxCollateralUSDC: 0,
        },
        payments: {
          interestPaymentType: createCountMap(DEFAULT_INTEREST_PAYMENT_TYPE_KEYS),
          principalPaymentType: createCountMap(DEFAULT_PRINCIPAL_PAYMENT_TYPE_KEYS),
          interestFrequency: createCountMap(DEFAULT_PAYMENT_FREQUENCY_KEYS),
          principalFrequency: createCountMap(DEFAULT_PRINCIPAL_FREQUENCY_KEYS),
        },
      };
    }
  }

  private isStaleOpenListing(account: any): boolean {
    const status = normalizeContractStatusKey(account?.status);
    if (status !== 'OpenNotFunded' && status !== 'OpenPartiallyFunded') {
      return false;
    }
    const expiresAt = Number(account?.expires_at ?? 0);
    if (!Number.isFinite(expiresAt) || expiresAt <= 0) {
      return true;
    }
    return Math.floor(Date.now() / 1000) >= expiresAt;
  }

  // Process contracts to calculate volume, active contracts, and outstanding USDC
  private processContracts(contracts: any[], calculation: PlatformStatsCalculation): void {
    for (const contract of contracts) {
      const account = contract.account;
      const statusKey = normalizeContractStatusKey(account?.status);
      const loanTypeKey = normalizeLoanTypeKey(account?.loan_type);
      const fundedUsdc = atomicToUsdc(account?.funded_amount);
      const targetUsdc = atomicToUsdc(account?.target_amount);
      const outstandingUsdc = atomicToUsdc(account?.outstanding_balance);
      const accruedInterestUsdc = atomicToUsdc(account?.accrued_interest);
      const collateralUsdc = atomicToUsdc(account?.collateral_amount);
      const principalPaidUsdc = atomicToUsdc(account?.total_principal_paid);
      const interestRatePercent = boundedBasisPointsToPercent(account?.interest_rate, 0, 100);
      const ltvPercentValue = boundedBasisPointsToPercent(account?.ltv_ratio, 10, 200);
      const termDays = safeBoundedNumber(account?.term_days, 0, 3650);
      const numContributions = safeBoundedNumber(account?.num_contributions, 0, 1000);

      if (numContributions !== null) {
        calculation.totalNumContributions += numContributions;
        calculation.contractsWithNumContributions += 1;
      }
      
      // Add borrower to unique wallets
      if (typeof account.borrower === 'string' && account.borrower !== 'PARSING_ERROR') {
        calculation.uniqueWalletAddresses.add(account.borrower);
        calculation.uniqueBorrowers.add(account.borrower);
      }

      // Add to total volume (all funded amounts converted to USDC)
      calculation.totalVolumeAmount += fundedUsdc;
      calculation.volumeByLoanType[loanTypeKey] = (calculation.volumeByLoanType[loanTypeKey] ?? 0) + fundedUsdc;

      calculation.contractsByStatus[statusKey] = (calculation.contractsByStatus[statusKey] ?? 0) + 1;

      // Count active contracts and sum outstanding USDC
      if (statusKey === 'Active' || statusKey === 'PendingRecall') {
        calculation.activeContractsCount++;
        
        // Add outstanding balance for active contracts
        calculation.outstandingUSDCAmount += outstandingUsdc;
        calculation.totalAccruedInterestActiveUSDC += accruedInterestUsdc;
        calculation.totalCollateralLockedActiveUSDC += collateralUsdc;
      }

      if (statusKey === 'Completed') {
        calculation.completedContractsCount += 1;
        calculation.completedPrincipalPaidUSDC += principalPaidUsdc;
      }

      if (statusKey === 'Liquidated') {
        calculation.liquidatedContractsCount += 1;
        calculation.liquidatedVolumeUSDC += fundedUsdc;
      }

      calculation.totalPrincipalPaidUSDC += principalPaidUsdc;

      // Collect values for histograms / summary stats
      calculation.loanSizeValuesUSDC.push(targetUsdc);
      if (interestRatePercent !== null) calculation.interestRateValuesPercent.push(interestRatePercent);
      if (termDays !== null) calculation.loanTermDaysValues.push(termDays);
      if (ltvPercentValue !== null) calculation.ltvPercentValues.push(ltvPercentValue);
      calculation.collateralValuesUSDC.push(collateralUsdc);

      if (targetUsdc > 0) {
        const fillRate = (fundedUsdc / targetUsdc) * 100;
        calculation.fillRatePercentValues.push(sanitizePercent(fillRate));
      }

      this.processPaymentConfiguration(account, calculation.paymentConfiguration);
    }
  }

  // Process contributions to add unique lenders
  private processContributions(contributions: any[], calculation: PlatformStatsCalculation): void {
    for (const contribution of contributions) {
      const account = contribution.account;
      
      // Add lender to unique wallets
      if (typeof account.lender === 'string' && account.lender.trim().length > 0) {
        calculation.uniqueWalletAddresses.add(account.lender);
        calculation.uniqueLenders.add(account.lender);
      }

      const contributionUsdc = safeUsdcAmount(account?.contribution_amount ?? account?.amount);
      if (contributionUsdc !== null) {
        calculation.totalContributedUSDC += contributionUsdc;
        calculation.contributionValuesUSDC.push(contributionUsdc);
      }

      const interestClaimedUsdc = safeUsdcAmount(account?.total_interest_claimed);
      if (interestClaimedUsdc !== null) {
        calculation.totalInterestClaimedUSDC += interestClaimedUsdc;
      }

      const principalClaimedUsdc = safeUsdcAmount(account?.total_principal_claimed);
      if (principalClaimedUsdc !== null) {
        calculation.totalPrincipalClaimedUSDC += principalClaimedUsdc;
      }
    }
  }

  private processPaymentConfiguration(account: any, paymentConfiguration: PaymentConfigurationMetrics): void {
    const interestPaymentTypeKey = normalizeInterestPaymentTypeKey(account?.interest_payment_type);
    const principalPaymentTypeKey = normalizePrincipalPaymentTypeKey(account?.principal_payment_type);
    const interestFrequencyKey = normalizePaymentFrequencyKey(account?.interest_frequency);

    const principalFrequencyKey = account?.principal_frequency === null || account?.principal_frequency === undefined
      ? 'None'
      : normalizePaymentFrequencyKey(account?.principal_frequency);

    processValueCount(paymentConfiguration.interestPaymentType, interestPaymentTypeKey);
    processValueCount(paymentConfiguration.principalPaymentType, principalPaymentTypeKey);
    processValueCount(paymentConfiguration.interestFrequency, interestFrequencyKey);
    processValueCount(paymentConfiguration.principalFrequency, principalFrequencyKey);
  }

  // Format platform statistics for frontend display
  public formatPlatformStats(stats: PlatformMetrics): FormattedPlatformMetrics {
    return {
      uniqueWallets: stats.uniqueWallets.toLocaleString(),
      totalVolume: `${stats.totalVolume.toFixed(2)} USDC`,
      activeContracts: stats.activeContracts.toLocaleString(),
      outstandingUSDC: `${stats.outstandingUSDC.toFixed(2)} USDC`,
      totalContracts: stats.totalContracts.toLocaleString(),
      contractsByStatus: stats.contractsByStatus,
      volumeByLoanType: stats.volumeByLoanType,
    };
  }

  // Get formatted platform statistics (convenience method)
  public async getFormattedPlatformStats(): Promise<FormattedPlatformMetrics> {
    const stats = await this.calculatePlatformStats();
    return this.formatPlatformStats(stats);
  }
}

export {
  PlatformStatsService,
  type PlatformMetrics,
  type FormattedPlatformMetrics
};

interface HistogramBucket {
  label: string;
  upperBoundInclusive: number;
}

// Pure functions using function keyword as per project rules
function createCountMap(keys: readonly string[]): Record<string, number> {
  const map: Record<string, number> = {};
  for (const key of keys) {
    map[key] = 0;
  }
  return map;
}

function normalizeContractStatusKey(status: unknown): string {
  if (typeof status === 'string' && status.trim().length > 0) {
    return status;
  }

  if (typeof status === 'number') {
    const statusMap: Record<number, string> = {
      0: 'OpenNotFunded',
      1: 'OpenPartiallyFunded',
      2: 'Active',
      3: 'PendingRecall',
      4: 'Completed',
      5: 'Cancelled',
      6: 'Liquidated',
    };
    return statusMap[status] ?? 'Unknown';
  }

  return 'Unknown';
}

function normalizeLoanTypeKey(loanType: unknown): string {
  if (typeof loanType === 'string' && loanType.trim().length > 0) {
    return loanType;
  }

  if (typeof loanType === 'number') {
    const loanTypeMap: Record<number, string> = {
      0: 'Demand',
      1: 'Committed',
    };
    return loanTypeMap[loanType] ?? 'Unknown';
  }

  return 'Unknown';
}

function atomicToUsdc(atomicUnits: unknown): number {
  if (typeof atomicUnits === 'bigint') {
    return Number(atomicUnits) / 1e6;
  }

  if (typeof atomicUnits === 'number') {
    return atomicUnits / 1e6;
  }

  if (typeof atomicUnits === 'string' && atomicUnits.trim().length > 0) {
    const asNumber = Number(atomicUnits);
    if (!Number.isNaN(asNumber)) {
      return asNumber / 1e6;
    }
  }

  return 0;
}

function calculateSummaryMetrics(values: number[]): SummaryMetrics {
  const clean = values.filter((value) => Number.isFinite(value));
  if (clean.length === 0) {
    return { count: 0, average: 0, median: 0, min: 0, max: 0 };
  }

  const sorted = [...clean].sort((a, b) => a - b);
  const count = sorted.length;
  const sum = sorted.reduce((acc, value) => acc + value, 0);
  const average = sum / count;
  const median = count % 2 === 1
    ? sorted[Math.floor(count / 2)]
    : (sorted[count / 2 - 1] + sorted[count / 2]) / 2;

  return {
    count,
    average,
    median,
    min: sorted[0],
    max: sorted[count - 1],
  };
}

function calculateHistogramMetrics(values: number[], buckets: readonly HistogramBucket[]): HistogramMetrics {
  const summary = calculateSummaryMetrics(values);
  const histogram = calculateHistogram(values, buckets);
  return { ...summary, buckets: histogram };
}

function calculateHistogram(values: number[], buckets: readonly HistogramBucket[]): Record<string, number> {
  const map = createCountMap(buckets.map((bucket) => bucket.label));

  for (const rawValue of values) {
    if (!Number.isFinite(rawValue)) continue;
    const value = rawValue < 0 ? 0 : rawValue;

    const matchingBucket = buckets.find((bucket) => value <= bucket.upperBoundInclusive);
    const label = matchingBucket ? matchingBucket.label : buckets[buckets.length - 1].label;
    map[label] = (map[label] ?? 0) + 1;
  }

  return map;
}

function basisPointsToPercent(value: unknown): number {
  const asNumber = safeNumber(value);
  if (asNumber === null) return 0;
  return asNumber / 100;
}

function boundedBasisPointsToPercent(
  value: unknown,
  minPercentInclusive: number,
  maxPercentInclusive: number
): number | null {
  const percent = basisPointsToPercent(value);
  if (!Number.isFinite(percent)) {
    return null;
  }
  if (percent < minPercentInclusive || percent > maxPercentInclusive) {
    return null;
  }
  return percent;
}

function safeNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'bigint') {
    const asNumber = Number(value);
    return Number.isFinite(asNumber) ? asNumber : null;
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    const asNumber = Number(value);
    return Number.isFinite(asNumber) ? asNumber : null;
  }

  return null;
}

function safeBoundedNumber(value: unknown, minInclusive: number, maxInclusive: number): number | null {
  const asNumber = safeNumber(value);
  if (asNumber === null) {
    return null;
  }
  if (asNumber < minInclusive || asNumber > maxInclusive) {
    return null;
  }
  return asNumber;
}

function safeUsdcAmount(value: unknown): number | null {
  const asNumber = safeNumber(value);
  if (asNumber === null) return null;
  return asNumber;
}

function sanitizePercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  return value;
}

function normalizePaymentFrequencyKey(value: unknown): string {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    const frequencyMap: Record<number, string> = {
      0: 'Daily',
      1: 'Weekly',
      2: 'BiWeekly',
      3: 'Monthly',
    };
    return frequencyMap[value] ?? 'Unknown';
  }

  return 'Unknown';
}

function normalizeInterestPaymentTypeKey(value: unknown): string {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    const paymentTypeMap: Record<number, string> = {
      0: 'OutstandingBalance',
      1: 'CollateralTransfer',
    };
    return paymentTypeMap[value] ?? 'Unknown';
  }

  return 'Unknown';
}

function normalizePrincipalPaymentTypeKey(value: unknown): string {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    const paymentTypeMap: Record<number, string> = {
      0: 'CollateralDeduction',
      1: 'NoFixedPayment',
    };
    return paymentTypeMap[value] ?? 'Unknown';
  }

  return 'Unknown';
}

function processValueCount(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

