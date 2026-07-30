---
"@spindesk/core": minor
---

Move attachment transfers onto presigned URLs — bytes no longer pass through the app server. Uploading is now two-phase: `POST /tickets/:id/attachments` takes `{ filename, contentType?, size? }` and returns `{ attachmentId, upload }` (a presigned `PUT` or `POST` form), and `POST /tickets/:id/attachments/:attId/complete` verifies the object landed and publishes the attachment. `GET /tickets/:id/attachments/:attId` now responds `302` to a presigned download URL instead of streaming the bytes. `@spindesk/core/client` exports `sendPresignedUpload` to drive the middle step.

The `spindesk_attachments` table gains a `status TEXT NOT NULL` column (`"pending"` until an upload is confirmed, then `"ready"`); only ready attachments are listed and served. Presigned URLs are valid for 15 minutes.

Updates futonic to `0.2.1-canary.b0fd21f`, whose storage is now built on [files-sdk](https://files-sdk.dev). Attachment bytes go to a per-service `spindesk_storage_objects` table by default; back them with any files-sdk adapter instead by installing `files-sdk` and passing e.g. `storage: { provider: s3({ bucket }) }`. An adapter that can't sign its own URLs (the database default) still needs `storage.signingKey` and `storage.baseUrl` — `createSpindesk` now throws at construction when they're missing, rather than failing requests later.

The export surface follows suit so hosts rarely need another package: `@spindesk/core` re-exports `FilesError` plus the storage types alongside the previously missing `Comment`, `TicketStatus`, `ServiceDeskConfig`, `AuthLike`, `AuthUser`, `ServiceDeskIdentity`, `ServiceDeskSchema` types and the `TICKET_STATUS` / `DEFAULT_MAX_ATTACHMENT_BYTES` constants, and `@spindesk/core/drizzle` adds `SPINDESK_STORAGE_TABLE_NAME` (`generateSpindeskSchema` now returns the storage table as `spindeskStorageObjects`). `PresignedUpload` is now an alias of files-sdk's `SignedUpload`.

Anyone who ran an earlier canary can carry their blobs over — the keys are identical under both schemes:

```sql
INSERT INTO spindesk_storage_objects (key, content_type, size, data, created_at)
SELECT key, content_type, size, data, created_at
FROM futonic_storage_objects WHERE owner = 'spindesk';
```
