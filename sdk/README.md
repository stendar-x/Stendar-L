# `@stendar-x/sdk`

TypeScript SDK for interacting with the Stendar protocol in two modes:

- `api` mode: call the backend REST API and receive unsigned transactions.
- `direct` mode: build Anchor instructions locally via the loaded IDL.

## Install

```bash
npm install @stendar-x/sdk
```

## Usage

```ts
import { Keypair } from '@solana/web3.js';
import { StendarClient } from '@stendar-x/sdk';

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

Direct/API operation coverage is documented in [`DIRECT_MODE.md`](./DIRECT_MODE.md).

## HTTP Retry Behavior

The SDK HTTP client retries requests that receive `429`, `502`, `503`, or `504` status codes, as well as transient network errors. Retries use exponential backoff and apply to **all HTTP methods**, including `POST`, `PUT`, and `DELETE`. Backend write endpoints should be idempotent to avoid duplicate mutations on retry.

## Canonical IDL Export

The SDK publishes the canonical protocol IDL as `stendarIdl`:

```ts
import { stendarIdl } from '@stendar-x/sdk';
```
