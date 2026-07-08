---
"@spindesk/core": patch
---

Migrate to futonic `0.1.1-canary.75d2b1a`. The service constructor now hands the endpoints factory a pre-bound `defineEndpoint` (its service-context middleware already baked in) instead of a `use` middleware array, so `createServiceDeskEndpoints` wraps it to authenticate each request inside the handler and the standalone auth middleware is removed.
