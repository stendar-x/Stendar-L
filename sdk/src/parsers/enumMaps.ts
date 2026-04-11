export const CONTRACT_STATUS_MAP: Record<number, string> = {
  0: 'OpenNotFunded',
  1: 'OpenPartiallyFunded',
  2: 'Active',
  3: 'PendingRecall',
  4: 'Completed',
  5: 'Cancelled',
  6: 'Liquidated',
};

export const LOAN_TYPE_MAP: Record<number, string> = {
  0: 'Demand',
  1: 'Committed',
};

export const FREQUENCY_MAP: Record<number, string> = {
  0: 'Daily',
  1: 'Weekly',
  2: 'BiWeekly',
  3: 'Monthly',
};

export const INTEREST_PAYMENT_TYPE_MAP: Record<number, string> = {
  0: 'OutstandingBalance',
  1: 'CollateralTransfer',
};

export const PRINCIPAL_PAYMENT_TYPE_MAP: Record<number, string> = {
  0: 'CollateralDeduction',
  1: 'NoFixedPayment',
};

export const PROPOSAL_STATUS_MAP: Record<number, string> = {
  0: 'Pending',
  1: 'Approved',
  2: 'Rejected',
  3: 'Expired',
  4: 'Cancelled',
};

export const VOTE_CHOICE_MAP: Record<number, string> = {
  0: 'Approve',
  1: 'Reject',
};

export const LISTING_TYPE_MAP: Record<number, string> = {
  0: 'FullPosition',
  1: 'PartialPosition',
};

export const TRADE_TYPE_MAP: Record<number, string> = {
  0: 'DirectSale',
  1: 'AcceptedOffer',
  2: 'PartialFill',
};
