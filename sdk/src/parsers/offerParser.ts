import { DISCRIMINATORS } from './discriminators';
import {
  assertDiscriminator,
  readBool,
  readI64,
  readPubkey,
  readU16,
  readU64,
  readU8,
} from './bufferUtils';
import { handleParserError, asUiUsdc } from './parserHelpers';
import type { ParseAccountOptions, ParsedOfferAccount } from './types';

const OFFER_RESERVED_BYTES = 96;

export function parseOfferAccount(data: Buffer, options?: ParseAccountOptions): ParsedOfferAccount | null {
  if (!assertDiscriminator(data, DISCRIMINATORS.TRADE_OFFER)) {
    return null;
  }

  try {
    let offset = 8;

    const listing = readPubkey(data, offset);
    offset += 32;
    const buyer = readPubkey(data, offset);
    offset += 32;
    const purchaseAmountRaw = readU64(data, offset);
    offset += 8;
    const offeredPriceRaw = readU64(data, offset);
    offset += 8;
    const createdAt = readI64(data, offset);
    offset += 8;
    const expiresAt = readI64(data, offset);
    offset += 8;
    const isActive = readBool(data, offset);
    offset += 1;
    const nonce = readU8(data, offset);
    offset += 1;
    const reserved = data.subarray(offset, offset + OFFER_RESERVED_BYTES);
    if (reserved.length !== OFFER_RESERVED_BYTES) {
      throw new RangeError('TradeOffer reserved bytes are truncated');
    }
    offset += OFFER_RESERVED_BYTES;
    const accountVersion = readU16(data, offset);

    return {
      listing,
      buyer,
      purchaseAmount: asUiUsdc(purchaseAmountRaw),
      purchaseAmountRaw: purchaseAmountRaw.toString(),
      offeredPrice: asUiUsdc(offeredPriceRaw),
      offeredPriceRaw: offeredPriceRaw.toString(),
      createdAt: createdAt.toString(),
      expiresAt: expiresAt.toString(),
      isActive,
      nonce,
      accountVersion,
    };
  } catch (error) {
    return handleParserError('TradeOffer', error, options);
  }
}
