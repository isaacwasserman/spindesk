---
"@spindesk/core": minor
---

Migrate to futonic `0.1.1-canary.237459b`, which has a new interface. The service is now built with `createFutonicServiceConstructor` and a validated `configSchema`, and `svc.db` is a Kysely instance (queried with logical table names that futonic prefixes to `servicedesk_*` at runtime). The factory's options change to `{ config, database: { connection, provider } }` and the service exposes `handler` directly (no more `createHandler`); the db schema moves to the new `ServiceDBSchema` shape. Also bumps `better-call` to `^2.0.5` and adds `kysely` as a dependency.
