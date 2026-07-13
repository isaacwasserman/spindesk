---
"@spindesk/core": patch
---

Make `createSpindeskClient`'s type portable and keep its call signatures inferable in consumers. Export a named `SpindeskClient` type alias and use it as the function's return type, so consumers can name the inferred client without reaching into futonic's nested `better-call` (`HasRequired`). Also build the client from the package's own `better-call/client` instead of `futonic/client`, so the client and `SpindeskRouter`'s endpoint types share one `Endpoint` identity — without this, a consumer holding a second `better-call` copy saw `client("/me")` collapse to `any`.
