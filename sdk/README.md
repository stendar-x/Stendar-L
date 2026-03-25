# `@stendar/sdk`

TypeScript SDK for interacting with the Stendar protocol in two modes:

- `api` mode: call the backend REST API and receive unsigned transactions.
- `direct` mode: build Anchor instructions locally via the loaded IDL.

## Install

```bash
npm install @stendar/sdk
```

## Usage

```ts
import { Keypair } from '@solana/web3.js';
import { StendarClient } from '@stendar/sdk';

const keypair = Keypair.generate();

const client = new StendarClient({
  mode: 'api',
  apiUrl: process.env.STENDAR_API_URL,
  apiKey: process.env.STENDAR_API_KEY,
});

const contracts = await client.contracts.list({ status: 'Active', page: 1, limit: 20 });

const tx = await client.lending.contribute({
  contractAddress: '...',
  lenderAddress: keypair.publicKey.toBase58(),
  amount: 1_000_000,
});
```

For direct mode, pass `direct` config with `connection`, `wallet`, `idl`, and optional `programId`.

## Canonical IDL Export

The SDK publishes the canonical protocol IDL as `stendarIdl`:

```ts
import { stendarIdl } from '@stendar/sdk';
```
