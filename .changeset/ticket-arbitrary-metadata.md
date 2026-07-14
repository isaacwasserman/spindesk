---
"@spindesk/core": minor
---

Allow arbitrary key/value `metadata` on tickets. Add an optional `metadata` JSON field, mirroring the existing `tags` pattern end-to-end: DB schema/migration, create + update bodies, response DTO, and (de)serialization. Metadata is opaque host-supplied data, surfaced as `{}` when absent and author/agent-editable with no vocabulary validation.
