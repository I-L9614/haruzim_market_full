# Credit customers, 1.0.4

## Operation

Both manager clients open credit management through the dedicated "לקוחות בהקפה" button. It is not embedded in the default orders screen. A manager creates a separate credit name and code (8-72 characters, maximum 72 UTF-8 bytes), then privately gives those to the customer. Codes are bcrypt hashes, never returned by account APIs. They are not regular customer-login passwords. Existing regular checkout is unchanged.

Credit checkout authenticates the name/code on the server, rate-limits attempts by source IP and normalized account, snapshots the credit account on the order and reserves stock normally. It adds no debt. Shipping adds no debt either. Marking a credit order delivered requires one explicit decision: order total, signed custom change with a reason, or no debt change. This decision, delivery, the account balance and immutable audit entry commit in one MongoDB transaction. The delivery audit primary key contains the order ID, so retries cannot charge it twice. Conflicting retries are rejected.

Amounts are stored as integer agorot. A positive balance is owed to the store; a negative balance is customer credit. A custom delivery amount is an increment/decrement, while the account edit form sets the new total balance. Manual balance changes and resets require a reason and confirmation. Version checks reject stale edits from another device. Reset does not erase history. Disabling credit blocks new credit checkouts but does not remove the debt or prevent accounting for an existing shipment. Code rotation blocks the old code; there is no code-recovery endpoint. Audit records retain actor, timestamp, before/after balance and order reference where relevant.

## Compatibility and deployment

Production is the Cloudflare Worker in `haruzim-worker`. The legacy Express backend has compatible routes through `backend/src/routes/creditCompatibility.js`, using the same accounting transaction service. Existing orders without a credit provider use the original offline path. New fields and separate collections are additive; no account, product, debt or order migration/reset is needed. No actual customer account or debt is seeded by deployment.

Do not roll the API back to a pre-credit version after accepting credit orders: old clients cannot decide debt correctly. Older desktop clients are refused when attempting to mark a credit order paid or deliver without a credit decision. They can still handle ordinary orders. Upgrade the desktop to 1.0.4 before handling credit deliveries. Hide the customer credit button if rollback is needed, stop new credit acceptance, and retain the credit-aware API for existing orders and ledger records. Never remove ledger collections to roll back.

Build mobile module before the customer site:

```
npm ci
npm run build:mobile-credit --workspace admin-desktop
VITE_API_URL=<production API>/api VITE_GOOGLE_CLIENT_ID=<existing public Google client ID> npm run build --workspace customer-web
VITE_API_URL=<production API>/api VITE_SOCKET_URL=<production API> npm run build --workspace admin-desktop
```

Always deploy the complete customer build including `/manager/`, icons and manifest. The manager manifest scope remains `/manager/`; no Windows startup or tray notification behavior changed.

## Verification

`cd haruzim-worker && npm ci && npm test` runs local isolated replica-set tests. These create test-only random secrets and data in disposable MongoDB, not production. Cases cover authentication, unique names, invalid credentials, disabled accounts, shipping without debt, required delivered decision, concurrent duplicate deliveries, conflicting decisions, signed balances, skip-add, stale edits, reset audit, existing offline checkout/cancellation, and legacy Express parity. The backend's existing 11 tests also pass. Browser acceptance uses mock data only and checks separate navigation, real balance editing/reset flow, masked fields, delivery decisions, and responsive layout.

Windows installer: custom NSIS upgrade logic from 1.0.3 is retained, versioned to 1.0.4. It stages the full payload, refuses busy files and retains the prior installation. Close fully from the tray before upgrade; do not uninstall first. The installer is unsigned. Full static extraction and payload hash checks are not a real Windows launch/upgrade test. Test 1.0.4 on the developer's Windows PC before using it at the shop. Existing 1.0.3 real-use confirmation does not certify the new 1.0.4 binary.
