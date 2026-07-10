---
"@spindesk/core": minor
---

`generateSpindeskSchema` now requires the host's drizzle dialect module: `generateSpindeskSchema("pg", pgCore)`. The returned `spindesk_*` tables are the host's drizzle-orm version, so a host on a different drizzle-orm (e.g. a `1.0.0-beta`) than the one spindesk was built against gets correctly-typed, portable tables with no TS2742. `drizzle-orm` is no longer needed as a dependency or peer of `@spindesk/core`.
