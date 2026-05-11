import { DISCRIMINATORS } from './discriminators';
import { assertDiscriminator, readBool, readPubkey, readU16, readU32, readU8 } from './bufferUtils';
import { handleParserError } from './parserHelpers';
import type { ParseAccountOptions, ParsedCollateralRegistryAccount, ParsedCollateralType } from './types';

const MAX_REASONABLE_COLLATERAL_TYPES = 256;
const COLLATERAL_REGISTRY_RESERVED_BYTES = 96;

export function parseCollateralRegistryAccount(data: Buffer, options?: ParseAccountOptions): ParsedCollateralRegistryAccount | null {
  if (!assertDiscriminator(data, DISCRIMINATORS.COLLATERAL_REGISTRY)) {
    return null;
  }

  try {
    let offset = 8;

    const authority = readPubkey(data, offset);
    offset += 32;

    const numCollateralTypes = readU8(data, offset);
    offset += 1;

    const vecLength = readU32(data, offset);
    offset += 4;
    if (vecLength > MAX_REASONABLE_COLLATERAL_TYPES) {
      throw new RangeError(`Unreasonable collateral type count: ${vecLength}`);
    }
    if (numCollateralTypes !== vecLength) {
      throw new RangeError(
        `Collateral registry count mismatch: numCollateralTypes=${numCollateralTypes}, vecLength=${vecLength}`
      );
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
      throw new RangeError('Collateral registry reserved bytes are truncated');
    }
    offset += COLLATERAL_REGISTRY_RESERVED_BYTES;
    const accountVersion = readU16(data, offset);

    return {
      authority,
      numCollateralTypes,
      collateralTypes,
      accountVersion,
    };
  } catch (error) {
    return handleParserError('CollateralRegistry', error, options);
  }
}
