import { DISCRIMINATORS } from './discriminators';
import { assertDiscriminator, readI64, readPubkey, readU64, readU8 } from './bufferUtils';
import { TRADE_TYPE_MAP } from './enumMaps';
import { asUiUsdc, mapEnumValue } from './parserHelpers';
import type { ParsedTradeEventAccount, ParsedTradeType } from './types';

export function parseTradeEventAccount(data: Buffer): ParsedTradeEventAccount | null {
  if (!assertDiscriminator(data, DISCRIMINATORS.TRADE_EVENT)) {
    return null;
  }

  try {
    let offset = 8; // discriminator

    const contract = readPubkey(data, offset);
    offset += 32;
    const contribution = readPubkey(data, offset);
    offset += 32;
    const seller = readPubkey(data, offset);
    offset += 32;
    const buyer = readPubkey(data, offset);
    offset += 32;
    const amountTradedRaw = readU64(data, offset);
    offset += 8;
    const salePriceRaw = readU64(data, offset);
    offset += 8;
    const platformFeeRaw = readU64(data, offset);
    offset += 8;
    const buyerFeeRaw = readU64(data, offset);
    offset += 8;
    const tradeType = mapEnumValue<ParsedTradeType>(TRADE_TYPE_MAP, readU8(data, offset));
    offset += 1;
    const timestamp = readI64(data, offset);
    offset += 8;
    const nonce = readU8(data, offset);

    return {
      contract,
      contribution,
      seller,
      buyer,
      amountTraded: asUiUsdc(amountTradedRaw),
      amountTradedRaw: amountTradedRaw.toString(),
      salePrice: asUiUsdc(salePriceRaw),
      salePriceRaw: salePriceRaw.toString(),
      platformFee: asUiUsdc(platformFeeRaw),
      platformFeeRaw: platformFeeRaw.toString(),
      buyerFee: asUiUsdc(buyerFeeRaw),
      buyerFeeRaw: buyerFeeRaw.toString(),
      tradeType,
      timestamp: timestamp.toString(),
      nonce,
    };
  } catch {
    return null;
  }
}
