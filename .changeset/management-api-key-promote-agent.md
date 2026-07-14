---
"@spindesk/core": minor
---

Add a `managementApiKey` config option and a session-free `POST /management/agents` endpoint. When a request carries the configured key as an `Authorization: Bearer <key>` token, it promotes a user to the `agent` role by better-auth id or email (resolving the email to an id via the auth adapter), upserting the sidecar `users` row and recording a `user-role-changed` activity. The key is compared in constant time, and the endpoint rejects with 401 when no key is configured or the token mismatches.
