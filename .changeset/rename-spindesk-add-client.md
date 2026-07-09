---
"@spindesk/core": minor
---

Rename the service to `spindesk`: `createSpindesk`, `SpindeskArgs`, and `SpindeskRouter` replace the `ServiceDesk`-prefixed exports, and physical tables now use the `spindesk_` prefix. Add a `@spindesk/core/client` entry point exporting `createSpindeskClient`, a typed futonic client bound to the service router. Remove the `@spindesk/core/drizzle` entry point and the exported `serviceDeskId` constant.
