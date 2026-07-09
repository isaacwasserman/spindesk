---
"@spindesk/core": patch
---

Move `futonic`, `better-call`, and `kysely` back to `dependencies` (futonic pinned to `0.1.1-canary.a7b3fdb`) so the required versions are always installed, and bundle the type declarations with `tsup` + `rollup-plugin-dts` so those packages' types are inlined into `@spindesk/core`'s `.d.ts`. This lets spindesk require a specific (canary) futonic version without producing type-portability errors in consumers, and consumers no longer need to install `futonic`, `better-call`, or `kysely` themselves. `drizzle-orm` remains an optional peer dependency (external in the emitted types) since the generated tables must share the consumer's drizzle instance.
