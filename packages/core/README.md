# @spindesk/core

An embeddable service desk API built on [futonic](https://github.com/isaacwasserman/futonic).

Host applications create the required tables in their own database and mount Spindesk as a route handler in any web-standard JavaScript app.

## Features

- No requests to external services.
- Uses the database that your app already has.
- Connects to the authentication that your app already uses (with [better-auth](https://better-auth.com) as a first-class citizen).
- Bring your own UI; we provide the logic, and you do whatever you want with it.

## Usage

### Installation

```sh
bun add @spindesk/core
```

### Database

Spindesk uses the database your application already has. That means you own the tables and the DDL to create them. Spindesk ships a dialect-agnostic schema whose abstract column types map to different physical types per dialect:

| Abstract type | PostgreSQL  | MySQL      | SQLite              |
| ------------- | ----------- | ---------- | ------------------- |
| `string`      | `text`      | `text`     | `text`              |
| `integer`     | `integer`   | `int`      | `integer`           |
| `boolean`     | `boolean`   | `boolean`  | `integer` (0/1)     |
| `timestamp`   | `timestamp` | `datetime` | `integer` (unixepoch) |
| `json`        | `jsonb`     | `json`     | `text`              |
| `blob`        | `bytea`     | `blob`     | `blob`              |

Spindesk stores timestamps as ISO `string`s (`text`), so its own columns only use `string`, `json`, `integer`, and `blob`.

Table and column names are physically prefixed with `spindesk_` and stored in `snake_case`. The SQLite DDL below is illustrative; translate the types via the table above for other dialects.

```sql
CREATE TABLE IF NOT EXISTS spindesk_users (
  id TEXT PRIMARY KEY NOT NULL,
  role TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS spindesk_tickets (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL,
  assignee_id TEXT,
  tags TEXT, -- JSON array of tags, e.g. ["billing","urgent"]
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS spindesk_attachments (
  id TEXT PRIMARY KEY NOT NULL,
  ticket_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  data BLOB NOT NULL,
  uploaded_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (ticket_id) REFERENCES spindesk_tickets(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS spindesk_comments (
  id TEXT PRIMARY KEY NOT NULL,
  ticket_id TEXT NOT NULL,
  parent_id TEXT,
  author_id TEXT NOT NULL,
  author_role TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (ticket_id) REFERENCES spindesk_tickets(id) ON DELETE CASCADE,
  FOREIGN KEY (parent_id) REFERENCES spindesk_comments(id) ON DELETE CASCADE
);
```

#### Drizzle

If your host uses Drizzle, `@spindesk/core/drizzle` builds the tables against your own drizzle-orm version — pass your dialect module and let your migration tooling emit the DDL:

```ts
import * as pg from "drizzle-orm/pg-core";
import { generateSpindeskSchema } from "@spindesk/core/drizzle";

export const spindeskTables = generateSpindeskSchema("pg", pg);
```

## Instantiation and Mounting

```ts
import { db } from "your-database";
import { createSpindesk } from "@spindesk/core";

const service = createSpindesk({
  database: {
    connection: db, // raw driver connection (Kysely dialect input)
    provider: "sqlite", // "pg" | "mysql" | "sqlite"
  },
  config: {
    auth, // your better-auth instance (or interface-compatible adapter)
    agentUserIds: ["..."], // users seeded with the "agent" role
    agentEmails: ["agent@example.com"], // or seed agents by email
    availableTags: ["billing", "bug", "question"],
    maxAttachmentBytes: 5 * 1024 * 1024,
  },
});

// Pass the mount path as `basePath`; it's stripped before routing.
const handler = service.createHandler({ basePath: "/api/servicedesk" });
const route = (request: Request) => handler.handle(request);
```

`createHandler` also exposes an OpenAPI reference at `/reference` by default; pass `{ openApi: false }` to disable it.

See [`ServiceDeskConfig`](./src/types.ts) for the full configuration surface.

## API

All routes are relative to the mount path. Requests are authenticated via the configured better-auth instance.

| Method   | Path                              | Description                          |
| -------- | --------------------------------- | ------------------------------------ |
| `GET`    | `/me`                             | Current identity and role.           |
| `POST`   | `/tickets`                        | Create a ticket.                     |
| `GET`    | `/tickets`                        | List tickets (Lucene-style filter).  |
| `GET`    | `/tickets/:id`                    | Fetch a single ticket.               |
| `PATCH`  | `/tickets/:id`                    | Update status, assignee, tags, etc.  |
| `GET`    | `/tickets/:id/comments`           | List comments (threaded).            |
| `POST`   | `/tickets/:id/comments`           | Add a comment or reply.              |
| `GET`    | `/tags`                           | List the allowed tag vocabulary.     |
| `POST`   | `/tickets/:id/attachments`        | Upload an attachment.                |
| `GET`    | `/tickets/:id/attachments`        | List a ticket's attachments.         |
| `GET`    | `/tickets/:id/attachments/:attId` | Download an attachment.              |
| `DELETE` | `/tickets/:id/attachments/:attId` | Delete an attachment.                |
| `PATCH`  | `/users/:id/role`                 | Set a user's role (agents only).     |

### Type-safe client

`@spindesk/core/client` wraps better-call's typed client with Spindesk's router types:

```ts
import { createSpindeskClient } from "@spindesk/core/client";

const client = createSpindeskClient({
  baseURL: "/api/servicedesk",
  credentials: "include",
});
```

## License

MIT
