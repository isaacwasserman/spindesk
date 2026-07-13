---
"@spindesk/core": patch
---

Tighten the response DTOs and let client options flow into call types. `Ticket.status` and `Comment.authorRole` are now typed as their enums (`TICKET_STATUS` / `"user" | "agent"`) instead of `string`, so the inferred client and OpenAPI response schemas carry the real unions. `createSpindeskClient` now preserves its options type (via a `const` type parameter), so per-client settings such as `throw: true` are reflected in every call's result type — a throwing client returns the payload directly instead of the `{ data, error }` envelope.
