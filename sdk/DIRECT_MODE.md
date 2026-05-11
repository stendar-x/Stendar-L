# Direct Mode Support Matrix

`StendarClient` supports two execution modes:

- `mode: "api"` -> all SDK operations call HTTP endpoints.
- `mode: "direct"` -> only a subset of operations build Anchor instructions locally through `StendarProgramClient`.

`mode: "direct"` still initializes `StendarApiClient` at construction time, so
`apiUrl` or the `STENDAR_API_URL` environment variable must be provided even if
only direct-mode operations will be used.

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
| `drawFromRevolvingTransaction` | Supported (`program.drawFromRevolving`) | Supported |
| `repayRevolvingTransaction` | Supported (`program.repayRevolving`) | Supported |
| `closeRevolvingFacilityTransaction` | Supported (`program.closeRevolvingFacility`) | Supported |
| `sweepContractPoolTransaction` | Supported (`program.sweepContractPool`) | Supported |
| `botCloseMaturedRevolvingTransaction` | Supported (`program.botCloseMaturedRevolving`) | Supported |
| `distributeStandbyFeesTransaction` | Supported (`program.distributeStandbyFees`) | Supported |
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
| `processProposalRecall` | Supported (`program.processProposalRecall`) | Supported |

## Trading, Community, Jobs, Queries

The current SDK implementation routes these modules through API endpoints only:

- `TradingActions`
- `CommunityActions`
- `JobActions`
- All query modules (`contracts`, `proposalQueries`, `tradingQueries`, `collateral`, `wallet`, `communityQueries`, `market`, `rates`, `platform`)

## Program-Client-Only Operations

`StendarProgramClient` also exposes lower-level direct instruction builders that
are not routed through `StendarClient` action classes:

| Operation | Program client method |
| --- | --- |
| Create debt contract instruction | `program.createDebtContract` |
| Process recall instruction | `program.processRecall` |
| Propose pool changes instruction | `program.proposePoolChanges` |
| Apply pool changes instruction | `program.applyPoolChanges` |
| Cancel pool changes instruction | `program.cancelPoolChanges` |
| Update pool name instruction | `program.updatePoolName` |
| Update operator name instruction | `program.updateOperatorName` |
| Claim pool yield instruction | `program.claimPoolYield` |
| Set yield preference instruction | `program.setYieldPreference` |
| Compound pool yield instruction | `program.compoundPoolYield` |
| Bot claim pool yield instruction | `program.botClaimPoolYield` |
