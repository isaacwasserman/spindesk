---
"@spindesk/core": minor
---

Add a management-key impersonation header (`IMPERSONATION_HEADER` = `x-impersonate-user-id`): a request carrying it together with a valid management API key runs as the given user, with that user's own role. This lets a trusted backend create tickets, upload attachments, comment, etc. on any user's behalf through the normal endpoints — no dedicated per-resource management endpoints required.
