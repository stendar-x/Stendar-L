import { DISCRIMINATORS } from './discriminators';
import {
  assertDiscriminator,
  readBool,
  readI64,
  readPubkey,
  readU16,
  readU32,
  readU64,
  readU8,
} from './bufferUtils';
import { LISTING_TYPE_MAP } from './enumMaps';
import { asUiUsdc, mapEnumValue } from './parserHelpers';
import type { ParsedListingAccount, ParsedListingType } from './types';

const LISTING_RESERVED_BYTES = 96;

export function parseListingAccount(data: Buffer): ParsedListingAccount | null {
  if (!assertDiscriminator(data, DISCRIMINATORS.TRADE_LISTING)) {
    return null;
  }

  try {
    let offset = 8; // discriminator

    const contract = readPubkey(data, offset);
    offset += 32;
    const seller = readPubkey(data, offset);
    offset += 32;
    const contribution = readPubkey(data, offset);
    offset += 32;

    const listingAmountRaw = readU64(data, offset);
    offset += 8;
    const askingPriceRaw = readU64(data, offset);
    offset += 8;
    const listingType = mapEnumValue<ParsedListingType>(LISTING_TYPE_MAP, readU8(data, offset));
    offset += 1;
    const createdAt = readI64(data, offset);
    offset += 8;
    const expiresAt = readI64(data, offset);
    offset += 8;
    const isActive = readBool(data, offset);
    offset += 1;
    const offerCount = readU32(data, offset);
    offset += 4;
    const highestOfferRaw = readU64(data, offset);
    offset += 8;
    const nonce = readU8(data, offset);
    offset += 1;
    const reserved = data.subarray(offset, offset + LISTING_RESERVED_BYTES);
    if (reserved.length !== LISTING_RESERVED_BYTES) {
      return null;
    }
    offset += LISTING_RESERVED_BYTES;
    const accountVersion = readU16(data, offset);

    return {
      contract,
      seller,
      contribution,
      listingAmount: asUiUsdc(listingAmountRaw),
      listingAmountRaw: listingAmountRaw.toString(),
      askingPrice: asUiUsdc(askingPriceRaw),
      askingPriceRaw: askingPriceRaw.toString(),
      listingType,
      createdAt: createdAt.toString(),
      expiresAt: expiresAt.toString(),
      isActive,
      offerCount,
      highestOffer: asUiUsdc(highestOfferRaw),
      highestOfferRaw: highestOfferRaw.toString(),
      nonce,
      accountVersion,
    };
  } catch {
    return null;
  }
}
