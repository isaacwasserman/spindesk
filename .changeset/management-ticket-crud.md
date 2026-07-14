---
"@spindesk/core": minor
---

Add a session-free management API for ticket CRUD on behalf of a user, authorized by the `managementApiKey` bearer token. `POST`/`GET`/`GET :id`/`PATCH`/`DELETE` under `/management/users/:userId/tickets` create, list, fetch, update, and permanently delete tickets scoped to the given user; the update applies every field including the agent-only `status`/`assigneeId`, and delete records a new `ticket-deleted` activity. The session create/list/update endpoints are refactored onto shared helpers so both surfaces stay in sync.
