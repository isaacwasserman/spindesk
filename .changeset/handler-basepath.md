---
"@spindesk/core": patch
---

`service.handler` now takes a **required** `{ basePath }` argument (via futonic) that strips a mount prefix from the request URL before routing. Hosts pass `handler(req, { basePath: "/api/servicedesk" })` (or `"/"` at root) instead of rewriting the URL themselves. Requires the corresponding futonic release.
