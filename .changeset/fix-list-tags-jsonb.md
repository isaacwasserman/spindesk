---
"@spindesk/core": patch
---

Fix `listTickets`/`getTicket` returning empty `tags`. Tags are stored in a `json` column, which the driver returns already parsed (an array), but `parseTags` only handled a JSON *string* — so reads produced `[]`. `parseTags` now accepts an already-parsed array as well as a string.
