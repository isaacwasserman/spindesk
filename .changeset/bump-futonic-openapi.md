---
"@spindesk/core": patch
---

Bump futonic to the OpenAPI-generator canary (`0.1.1-canary.1687ef1`). The service's `/reference` document is now spec-accurate: every method on a shared path is kept (e.g. `POST /tickets` is no longer dropped behind `GET /tickets`), all HTTP verbs are emitted, and `:id` route segments are templated as `{id}` path parameters. No source changes — the handler API is unchanged.
