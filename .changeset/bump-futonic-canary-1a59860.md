---
"@spindesk/core": patch
---

Bump the `futonic` dependency to `0.1.1-canary.1a59860`, which splits handler creation from request handling (`service.createHandler({ basePath, openApi }).handle(request)`) and enables the OpenAPI reference at `/reference` by default. The demo host now builds its handler once via `createHandler` and dispatches with `handler.handle(request)`.
