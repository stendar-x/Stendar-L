# Platform Stats Transparency

This directory publishes the exact logic used to compute platform statistics shown in the product UI.

## Source of truth

- `platformStatsService.ts` contains the exact logic used to compute the aggregate statistics displayed in the Stendar product UI.
- Inputs are on-chain account reads (`DebtContract` and `LenderContribution` account data).
- Outputs are aggregate metrics (counts, totals, histograms, rates).

## Data handling

- No user profile data is required.
- No personally identifying information is collected by this calculation.
- All metrics are derived from publicly available on-chain data.

## Sync policy

When product stats logic changes, maintainers must update this file in the same release cycle.
