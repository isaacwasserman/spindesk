---
"@spindesk/core": patch
---

Fix two consumer-facing typing regressions in the bundled declarations:

- Pin the public `createSpindesk` config type explicitly. The service config type is inferred from a `StandardSchemaV1<TConfig>` position that the declaration bundler can't preserve (it emitted `Record<string, never>`), so consumers couldn't pass a config. `SpindeskArgs` now carries the real `SpindeskConfig` shape.
- Re-export the better-call types (`Endpoint`, `EndpointMetadata`, `EndpointRuntimeOptions`, `Middleware`, `Router`) that surface through `createSpindesk`'s return, so a consumer inferring a type over the service no longer trips TS4058 ("cannot be named").
