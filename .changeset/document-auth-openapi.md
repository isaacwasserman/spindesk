---
"@spindesk/core": patch
---

The service now documents its own authentication in the OpenAPI reference. `createSpindesk`'s handler injects a `sessionCookie` security scheme (with a description of the better-auth session flow) and applies it document-wide, so hosts get accurate auth docs without configuring anything; they can still extend `securitySchemes` or override `security` via their own `openApi` options. The agent-only `PATCH /users/:id/role` operation additionally documents its agent-role requirement and 403 response via `metadata.openapi`.
