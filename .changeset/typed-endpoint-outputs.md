---
"@spindesk/core": patch
---

Give the service-desk endpoints typed return values. Query results are no longer cast to `Record<string, unknown>` — the row shapes come typed from the Kysely instance. Zod response schemas are now the source of truth for the `Ticket`/`Comment`/`Attachment` DTOs and are attached to each endpoint via futonic's `output` option, so the shape drives the OpenAPI `200` body, the typed client's result type, and a compile-time check on the handler return. Bumps futonic to `0.1.1-canary.b528377` for the `output` option.
