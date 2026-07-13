---
"@spindesk/core": minor
---

Add a monotonic per-service ticket `number` as an alternative key. Each ticket is assigned the next `number` on create (allocated as `MAX(number)+1` inside a transaction) and it is surfaced on the ticket response schema. Ticket id-based routes (`/tickets/:id` and its comments/attachments) now resolve an all-digit path segment by `number`, falling back to the UUID `id`, and key downstream writes off the resolved canonical UUID — so a ticket is addressable by either key.
