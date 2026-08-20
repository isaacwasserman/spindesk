---
"@spindesk/core": patch
---

Fix a race condition in user provisioning where parallel requests for the same new user could crash on a duplicate-key constraint. The insert now uses `ON CONFLICT DO NOTHING` and re-fetches the existing row when the insert is a no-op.
