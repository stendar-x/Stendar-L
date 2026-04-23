import { DISCRIMINATORS } from './discriminators';
import { assertDiscriminator, readBool, readPubkey, readU16, readU32, readU8 } from './bufferUtils';
import type { ParsedCollateralRegistryAccount, ParsedCollateralType } from './types';

const MAX_REASONABLE_COLLATERAL_TYPES = 256;
const COLLATERAL_REGISTRY_RESERVED_BYTES = 96;

export function parseCollateralRegistryAccount(data: Buffer): ParsedCollateralRegistryAccount | null {
  if (!assertDiscriminator(data, DISCRIMINATORS.COLLATERAL_REGISTRY)) {
    return null;
  }

  try {
    let offset = 8; // discriminator

    const authority = readPubkey(data, offset);
    offset += 32;

    const numCollateralTypes = readU8(data, offset);
    offset += 1;

    const vecLength = readU32(data, offset);
    offset += 4;
    if (vecLength > MAX_REASONABLE_COLLATERAL_TYPES) {
      return null;
    }
    if (numCollateralTypes !== vecLength) {
      return null;
    }

    const collateralTypes: ParsedCollateralType[] = [];
    for (let i = 0; i < vecLength; i += 1) {
      const mint = readPubkey(data, offset);
      offset += 32;
      const oraclePriceFeed = readPubkey(data, offset);
      offset += 32;
      const decimals = readU8(data, offset);
      offset += 1;
      const liquidationBufferBps = readU16(data, offset);
      offset += 2;
      const minCommittedFloorBps = readU16(data, offset);
      offset += 2;
      const isActive = readBool(data, offset);
      offset += 1;

      collateralTypes.push({
        mint,
        oraclePriceFeed,
        decimals,
        liquidationBufferBps,
        minCommittedFloorBps,
        isActive,
      });
    }

    const reserved = data.subarray(offset, offset + COLLATERAL_REGISTRY_RESERVED_BYTES);
    if (reserved.length !== COLLATERAL_REGISTRY_RESERVED_BYTES) {
      return null;
    }
    offset += COLLATERAL_REGISTRY_RESERVED_BYTES;
    const accountVersion = readU16(data, offset);

    return {
      authority,
      numCollateralTypes,
      collateralTypes,
      accountVersion,
    };
  } catch {
    return null;
  }
}
