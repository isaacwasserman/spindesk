---
"@spindesk/core": patch
---

Move `better-call`, `futonic`, and `kysely` from `dependencies` to `peerDependencies` (kept in `devDependencies` for local builds), and re-export the `Role` type from the package entry point.
