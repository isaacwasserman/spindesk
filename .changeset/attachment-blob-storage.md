---
"@spindesk/core": minor
---

Store attachment bytes in futonic's blob storage (`ctx.storage`) instead of a `data` column on the attachments table. The `spindesk_attachments` table now holds metadata only — drop its `data` column — and the bytes live under a per-attachment key in the configured store. By default they go to futonic's built-in database-backed store (a framework-owned `futonic_storage_objects` table, auto-created on first use); pass the new `storage` option to `createSpindesk` to supply a cloud-backed `StorageProvider` for production. Requires futonic `0.2.1-canary` or later.
