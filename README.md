# spindesk

## Database schema

The service-desk schema is defined in `packages/core/src/schema.ts`. futonic
prefixes every table with the service id (`servicedesk`), so the tables land in
the host database as `servicedesk_users`, `servicedesk_tickets`,
`servicedesk_attachments`, and `servicedesk_comments` — no collisions with host
or sibling-service tables. The equivalent SQL DDL lives in
`apps/demo/src/host/db/servicedesk.migration.sql`.

### `servicedesk_users`

Sidecar user info keyed by the better-auth user id; holds only the
service-desk-specific bits the host's auth doesn't know about.

| Column       | Type | Notes                                     |
| ------------ | ---- | ----------------------------------------- |
| `id`         | TEXT | Primary key (better-auth user id)         |
| `role`       | TEXT | Required. One of `user`, `agent`          |
| `created_at` | TEXT | Required                                  |

### `servicedesk_tickets`

| Column        | Type | Notes                                                    |
| ------------- | ---- | -------------------------------------------------------- |
| `id`          | TEXT | Primary key                                              |
| `user_id`     | TEXT | Required. Ticket author                                  |
| `subject`     | TEXT | Required                                                 |
| `description` | TEXT | Required                                                 |
| `status`      | TEXT | Required. One of `open`, `pending`, `resolved`, `closed` |
| `assignee_id` | TEXT | Nullable                                                 |
| `tags`        | TEXT | Nullable. Space-delimited tag list (e.g. `" billing urgent "`), denormalized so Lucene filters map to one column |
| `archived_at` | TEXT | Nullable. Set when the author archives; hides from default listings |
| `created_at`  | TEXT | Required                                                 |
| `updated_at`  | TEXT | Required                                                 |

### `servicedesk_attachments`

Ticket file attachments; `data` holds the raw bytes (BYTEA in Postgres, BLOB in
SQLite/MySQL).

| Column         | Type    | Notes                                                       |
| -------------- | ------- | ---------------------------------------------------------- |
| `id`           | TEXT    | Primary key                                                |
| `ticket_id`    | TEXT    | Required. FK → `servicedesk_tickets(id)`, `ON DELETE CASCADE` |
| `filename`     | TEXT    | Required                                                   |
| `content_type` | TEXT    | Required                                                   |
| `size`         | INTEGER | Required                                                   |
| `data`         | BLOB    | Required. Raw file bytes                                   |
| `uploaded_by`  | TEXT    | Required                                                   |
| `created_at`   | TEXT    | Required                                                   |

### `servicedesk_comments`

| Column        | Type | Notes                                                              |
| ------------- | ---- | ----------------------------------------------------------------- |
| `id`          | TEXT | Primary key                                                       |
| `ticket_id`   | TEXT | Required. FK → `servicedesk_tickets(id)`, `ON DELETE CASCADE`     |
| `parent_id`   | TEXT | Nullable. Self-referential FK → `servicedesk_comments(id)`, `ON DELETE CASCADE`; null for top-level comments |
| `author_id`   | TEXT | Required                                                          |
| `author_role` | TEXT | Required. Snapshot of the author's role at write time, for display |
| `body`        | TEXT | Required                                                          |
| `created_at`  | TEXT | Required                                                          |
