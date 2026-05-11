import type { ParsedContractAccount } from '../parsers/types';
import { asUiUsdc } from '../parsers/parserHelpers';

export interface ContractCapacity {
  /** Display-only value; use `remainingAmountRaw` for precise arithmetic. */
  remainingAmount: number;
  remainingAmountRaw: string;
  acceptsPartialFill: boolean;
  /** Display-only value; use `minPartialFillAmountRaw` for precise arithmetic. */
  minPartialFillAmount: number;
  minPartialFillAmountRaw: string;
}

export function getContractCapacity(contract: ParsedContractAccount): ContractCapacity {
  const targetAmountRaw = BigInt(contract.targetAmountRaw);
  const fundedAmountRaw = BigInt(contract.fundedAmountRaw);
  const remainingAmountRaw = targetAmountRaw > fundedAmountRaw ? targetAmountRaw - fundedAmountRaw : 0n;
  const acceptsPartialFill = contract.allowPartialFill && contract.partialFundingFlag > 0;
  const minPartialFillAmountRaw = (targetAmountRaw * BigInt(contract.minPartialFillBps)) / 10_000n;

  return {
    remainingAmount: asUiUsdc(remainingAmountRaw),
    remainingAmountRaw: remainingAmountRaw.toString(),
    acceptsPartialFill,
    minPartialFillAmount: asUiUsdc(minPartialFillAmountRaw),
    minPartialFillAmountRaw: minPartialFillAmountRaw.toString(),
  };
}
