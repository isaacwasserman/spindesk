---
"@spindesk/core": patch
---

Derive `SpindeskRouter` from `ReturnType<typeof createSpindesk>["endpoints"]` instead of `typeof createSpindeskEndpoints`, so the exported router type no longer references the Kysely-typed endpoint-builder. Combined with futonic's db-erased `defineService` return, this keeps the full `Kysely<Schema>` type out of the published `.d.ts` — shrinking the bundled declarations dramatically while still requiring no `kysely` peer dependency.
