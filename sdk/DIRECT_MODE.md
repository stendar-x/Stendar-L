# Direct Mode Support Matrix

`StendarClient` supports two execution modes:

- `mode: "api"` -> all SDK operations call HTTP endpoints.
- `mode: "direct"` -> only a subset of operations build Anchor instructions locally through `StendarProgramClient`.

`mode: "direct"` still initializes `StendarApiClient`, so an `apiUrl` is required for any API-only operation.

## Lending Actions

| Operation | Direct mode | API mode |
| --- | --- | --- |
| `contribute` | Supported (`program.contributeToContract`) | Supported |
| `makePaymentWithDistribution` | Supported (`program.makePaymentWithDistribution`) | Supported |
| `claimFromEscrow` | Supported (`program.claimFromEscrow`) | Supported |
| `refundLender` | Supported (`program.refundLender`) | Supported |
| `withdrawContribution` | Supported (`program.withdrawContribution`) | Supported |
| `approveFunder` | Supported (`program.approveFunder`) | Supported |
| `cancelContract` | Supported (`program.cancelContract`) | Supported |
| `createContractTransaction` | API-only | Supported |
| `createStandardContractTransaction` | API-only | Supported |
| `requestRecallTransaction` | API-only | Supported |
| `repayRecallTransaction` | API-only | Supported |
| `addCollateralTransaction` | API-only | Supported |
| `closeListingTransaction` | API-only | Supported |
| `submitTransaction` | API-only | Supported |
| `getTransactionStatus` | API-only | Supported |

## Proposal Actions

| Operation | Direct mode | API mode |
| --- | --- | --- |
| `createTermProposal` | Supported (`program.createTermProposal`) | Supported |
| `voteOnProposal` | Supported (`program.voteOnProposal`) | Supported |
| `cancelTermProposal` | Supported (`program.cancelTermProposal`) | Supported |
| `expireTermProposal` | Supported (`program.expireTermProposal`) | Supported |
| `closeProposalAccounts` | Supported (`program.closeProposalAccounts`) | Supported |

## Trading, Community, Jobs, Queries

The current SDK implementation routes these modules through API endpoints only:

- `TradingActions`
- `CommunityActions`
- `JobActions`
- All query modules (`contracts`, `proposalQueries`, `tradingQueries`, `collateral`, `wallet`, `communityQueries`, `market`, `rates`, `platform`)
