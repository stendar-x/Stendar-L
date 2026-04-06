# Stendar Smart Contract

A modular Solana smart contract for decentralized lending built with Rust and Anchor.

## Architecture

The smart contract is organized into logical modules for maintainability and clarity:

### Core Modules

#### `src/lib.rs`
- Main program entry point
- Declares and re-exports public program modules
- Contains the `#[program]` macro with instruction handlers

#### `src/state.rs`
- **Account Data Structures**: `State`, `DebtContract`, `LenderContribution`, `LenderEscrow`
- **Enums**: `ContractStatus`, `LoanType`, `PaymentFrequency`, `InterestPaymentType`, `PrincipalPaymentType`
- **Return Types**: `PlatformStats`

#### `src/contexts/`
- **Account Validation Structs** are split by domain:
  - `admin.rs`
  - `lending.rs`
  - `payment.rs`
  - `trading.rs`
- **Seed Definitions** and account constraints are co-located with each context.

#### `src/errors.rs`
- **Error Definitions**: All custom error codes with descriptive messages
- **Error Handling**: Centralized error management for the entire program

#### `src/utils/`
- Utility logic split by concern:
  - `interest.rs`
  - `trading.rs`
- Shared calculation and validation helpers for instruction modules.

### Instruction Modules

#### `src/instructions/mod.rs`
- Module declarations and re-exports
- Organizes instruction handlers by functionality

#### `src/instructions/lending.rs`
- **Contract Lifecycle**: `initialize_state`, `create_debt_contract`, `cancel_contract`
- **Lending Operations**: `contribute_to_contract`, `distribute_to_escrows`, `refund_lender`
- **Escrow Management**: `claim_from_escrow`, `update_lender_escrow`
- **Contract Operations**: `liquidate_contract`, `update_contract_state`

#### `src/instructions/payment_operations.rs`
- **Payment Processing**: `make_payment`, `make_payment_with_distribution`
- **Complex Logic**: Payment distribution to multiple lenders

#### `src/instructions/admin_operations.rs`
- **Treasury Management**: initialization, authority updates, withdrawals
- **Automated Operations**: bot-authorized interest and principal transfers to lenders
- **Platform Controls**: pause toggle, aggregate statistics

#### `src/instructions/trading.rs`
- **Secondary Position Trading**: listing creation, offer creation/acceptance, listing cancellation
- **Position Utilities**: transfer and valuation helpers

## Key Features

### Contract Creation
- Deterministic contract addresses using seeds
- Flexible loan terms (interest rates, payment schedules, LTV ratios)
- Collateral management with automatic transfers

### Multi-Lender Support
- Multiple lenders can contribute to a single contract
- Proportional interest and principal distribution
- Individual escrow accounts for each lender

### Payment Processing
- Automatic interest accrual based on payment type
- Scheduled principal payments
- Complex payment distribution logic

### Security Features
- Comprehensive input validation
- Access control for all operations
- Overflow-safe arithmetic for critical payment paths
- Strict PDA/signer ownership checks for high-risk fund movement paths
- Proper account ownership verification

## Usage

### Initialize Platform
```rust
initialize(ctx: Context<Initialize>) -> Result<()>
```

### Create Debt Contract
```rust
create_debt_contract(
    ctx: Context<CreateDebtContract>,
    contract_seed: u64,
    target_amount: u64,
    interest_rate: u64,
    term_days: u32,
    collateral_amount: u64,
    loan_type: LoanType,
    ltv_ratio: u64,
    interest_payment_type: InterestPaymentType,
    principal_payment_type: PrincipalPaymentType,
    interest_frequency: PaymentFrequency,
    principal_frequency: Option<PaymentFrequency>,
    max_lenders: u16,
    partial_funding_enabled: bool,
    distribution_method: DistributionMethod,
) -> Result<()>
```

### Contribute to Contract
```rust
contribute_to_contract(
    ctx: Context<ContributeToContract>,
    amount: u64,
) -> Result<()>
```

### Make Payment
```rust
make_payment(
    ctx: Context<MakePayment>,
    amount: u64,
) -> Result<()>
```

## Development

### Building
```bash
anchor build
```

### Testing
```bash
anchor test
```

### Deployment
```bash
anchor deploy --provider.cluster devnet
```

## Security Considerations

- All monetary calculations use checked arithmetic to prevent overflows
- Signer/authority checks gate key payment, liquidation, and automation operations
- Input validation ensures reasonable bounds on all parameters
- Access controls prevent unauthorized operations
- PDA structure ensures deterministic and secure account generation

## Contributing

See the repository root [`CONTRIBUTING.md`](../../CONTRIBUTING.md) for the full contribution workflow including PR requirements, required tests, and IDL coupling rules.