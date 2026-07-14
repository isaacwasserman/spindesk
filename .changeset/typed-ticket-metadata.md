---
"@spindesk/core": minor
---

Let hosts type ticket `metadata` with a call-time type argument. `createSpindesk<MyMeta>(…)` now types `metadata` end-to-end — the create/update request bodies, the ticket responses, and the typed client all surface `MyMeta` — and `createSpindeskClient<MyMeta>()(…)` pins the same shape on the client (now called in two steps, since TypeScript can't infer the client options while a metadata type is given explicitly). Both default to an open record, so untyped usage is unchanged. Validation stays shape-agnostic; the type is a compile-time view the caller vouches for. Bumps `futonic` to `0.1.1-canary.063ab81`, whose service constructor accepts the call-time endpoints-override type argument this relies on.
