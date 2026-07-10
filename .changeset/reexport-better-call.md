---
"@spindesk/core": patch
---

Re-export `better-call`'s type surface directly from the package entry (not only transitively via futonic). When a consumer's tree holds multiple `better-call` copies, spindesk's endpoint types resolve to its own copy; re-exporting it directly keeps those types nameable via `@spindesk/core`, avoiding TS2742/TS2883 "cannot be named" errors in consumers.
