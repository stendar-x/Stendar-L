import { DISCRIMINATORS } from './discriminators';
import { assertDiscriminator, readI64, readPubkey, readU16, readU8 } from './bufferUtils';
import { VOTE_CHOICE_MAP } from './enumMaps';
import { mapEnumValue } from './parserHelpers';
import type { ParsedProposalVoteAccount, ParsedVoteChoice } from './types';

const PROPOSAL_VOTE_RESERVED_BYTES = 96;

export function parseProposalVoteAccount(data: Buffer): ParsedProposalVoteAccount | null {
  if (!assertDiscriminator(data, DISCRIMINATORS.PROPOSAL_VOTE)) {
    return null;
  }

  try {
    let offset = 8;

  const proposal = readPubkey(data, offset);
  offset += 32;
  const voter = readPubkey(data, offset);
  offset += 32;
  const voteChoice = mapEnumValue<ParsedVoteChoice>(VOTE_CHOICE_MAP, readU8(data, offset));
  offset += 1;
  const votedAt = readI64(data, offset);
  offset += 8;
  const recallOnRejection = readU8(data, offset) === 1;
  offset += 1;

  const reserved = data.subarray(offset, offset + PROPOSAL_VOTE_RESERVED_BYTES);
  if (reserved.length !== PROPOSAL_VOTE_RESERVED_BYTES) {
    return null;
  }
  offset += PROPOSAL_VOTE_RESERVED_BYTES;

  const accountVersion = readU16(data, offset);

  return {
    proposal,
    voter,
    voteChoice,
    votedAt: votedAt.toString(),
    recallOnRejection,
    reservedHex: reserved.toString('hex'),
    accountVersion,
  };
  } catch {
    return null;
  }
}
