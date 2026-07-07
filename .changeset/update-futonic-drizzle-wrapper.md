---
"@spindesk/core": minor
---

Update futonic to `0.1.1-canary.55aeaaa` and add a `@spindesk/core/drizzle` entry point exporting `serviceDeskDrizzleSchema(dialect)`, a wrapper over futonic's `generateSchema` bound to this service's schema and id (with `drizzle-orm` as an optional peer dependency). Also exports a shared `serviceDeskId` constant.
