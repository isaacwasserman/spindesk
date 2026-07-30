# @spindesk/core

An embeddable service desk API built on [futonic](https://github.com/isaacwasserman/futonic). Host applications create the required tables in their own database and mount Spindesk as a route handler in any web-standard JavaScript app.

This is the usage reference. For the monorepo layout and the reference demo host, see the [repository README](https://github.com/isaacwasserman/spindesk).

## Features

- No requests to external services.
- Uses the database that your app already has.
- Connects to the authentication that your app already uses (with [better-auth](https://better-auth.com) as a first-class citizen).
- Bring your own UI; we provide the logic, and you do whatever you want with it.
- Attach arbitrary key/value metadata to tickets — and optionally type its shape end-to-end with a type argument (see [Typed ticket metadata](#typed-ticket-metadata)).

## Install

```sh
bun add @spindesk/core
```

### Entry points

Everything a host needs is re-exported from Spindesk, so futonic never has to be a direct dependency.

| Entry point              | Contents                                                                                                                                            |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@spindesk/core`         | `createSpindesk`, the DTO and config types (`Ticket`, `Comment`, `Attachment`, `ServiceDeskConfig`, …), `IMPERSONATION_HEADER`, `TICKET_STATUS`, and the storage types plus `FilesError` for inspecting a storage failure. |
| `@spindesk/core/client`  | `createSpindeskClient` and `sendPresignedUpload`.                                                                                                     |
| `@spindesk/core/drizzle` | `generateSpindeskSchema` (which includes the built-in store's table) and `SPINDESK_STORAGE_TABLE_NAME`.                                                |

Backing attachments with anything other than the built-in database store is the one thing that needs a second package: install [files-sdk](https://files-sdk.dev) and pass one of its adapters as `storage.provider` (see [Attachment storage](#attachment-storage)).

## Database

Spindesk uses the database your application already has. That means you own the tables and the DDL to create them. Spindesk ships a dialect-agnostic schema whose abstract column types map to different physical types per dialect:

| Abstract type | PostgreSQL  | MySQL      | SQLite              |
| ------------- | ----------- | ---------- | ------------------- |
| `string`      | `text`      | `text`     | `text`              |
| `integer`     | `integer`   | `int`      | `integer`           |
| `boolean`     | `boolean`   | `boolean`  | `integer` (0/1)     |
| `timestamp`   | `timestamp` | `datetime` | `integer` (unixepoch) |
| `json`        | `jsonb`     | `json`     | `text`              |

Spindesk stores timestamps as ISO `string`s (`text`), so its own columns only use `string`, `json`, and `integer`.

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
  metadata TEXT, -- JSON object of arbitrary key/value metadata
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
  uploaded_by TEXT NOT NULL,
  status TEXT NOT NULL, -- "pending" until the presigned upload is confirmed, then "ready"
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

-- Attachment bytes, only when they go to the built-in database store (see
-- Attachment storage). It is created on first use, so this DDL is optional;
-- `data` is `bytea` on PostgreSQL and `longblob` on MySQL.
CREATE TABLE IF NOT EXISTS spindesk_storage_objects (
  key TEXT PRIMARY KEY NOT NULL,
  content_type TEXT,
  size INTEGER NOT NULL,
  data BLOB NOT NULL,
  created_at TEXT NOT NULL
);
```

### Drizzle

If your host uses Drizzle, `@spindesk/core/drizzle` builds the tables against your own drizzle-orm version — pass your dialect module and let your migration tooling emit the DDL:

```ts
import * as pg from "drizzle-orm/pg-core";
import { generateSpindeskSchema } from "@spindesk/core/drizzle";

export const spindeskTables = generateSpindeskSchema("pg", pg);
```

The result includes `spindeskStorageObjects`, the built-in store's table; drop that key if you back attachments with your own provider.

### Attachment storage

Attachment bytes live in futonic's blob storage — a [files-sdk](https://files-sdk.dev) `Files` instance scoped to Spindesk's own key namespace — not in the `spindesk_attachments` table, which holds only metadata. Bytes never transit the app server: clients upload and download through **presigned URLs**.

By default the bytes go to futonic's database-backed adapter, which keeps them in a `spindesk_storage_objects` table it creates on first use. That adapter can't sign its own URLs, so futonic signs against a transfer route it mounts at `/_storage` under your base path — which means you must supply a `signingKey` and the `baseUrl` the service is reachable at. **`createSpindesk` throws at construction if they're missing.** The default is fine for development but not for large objects or production; supply a files-sdk adapter there:

```ts
import { s3 } from "files-sdk/s3";

const service = createSpindesk({
  database: { connection: db, provider: "sqlite" },
  config: { auth /* … */ },
  storage: {
    // Any files-sdk adapter; omit for the database-backed default.
    provider: s3({ bucket: "my-uploads", region: "us-east-1" }),
    // Required only for adapters that can't sign their own URLs.
    signingKey: process.env.STORAGE_SIGNING_KEY,
    baseUrl: "https://app.example.com/api/servicedesk",
  },
});
```

An adapter that signs its own URLs (S3 and friends) needs neither option, and futonic mounts no transfer route for it. files-sdk ships adapters for 40-plus backends behind its own subpaths (`files-sdk/s3`, `files-sdk/gcs`, `files-sdk/azure`, `files-sdk/memory`, …), each with its own optional peer dependencies; install `files-sdk` to reach them. The adapter type is re-exported as `FutonicStorageAdapter`.

#### Uploading an attachment

Uploads are two-phase. `POST /tickets/:id/attachments` takes the file's metadata and returns an `attachmentId` plus a presigned `upload` target; the client writes the bytes straight to the store and then calls `/complete`, which verifies the object landed, records its true size and content type, and publishes the attachment. Pending uploads are never listed or served, so an abandoned upload simply never appears.

`@spindesk/core/client` ships `sendPresignedUpload` for the middle step — it handles both target shapes an adapter may return (a signed `PUT`, which is what the built-in store always mints, or a `POST` form, which is what S3 mints for a size-capped upload):

```ts
import { sendPresignedUpload } from "@spindesk/core/client";

const { attachmentId, upload } = await client("@post/tickets/:id/attachments", {
  params: { id: ticketId },
  body: { filename: file.name, contentType: file.type, size: file.size },
});
await sendPresignedUpload(upload, file, { contentType: file.type, filename: file.name });
const attachment = await client("@post/tickets/:id/attachments/:attId/complete", {
  params: { id: ticketId, attId: attachmentId },
});
```

`maxAttachmentBytes` is enforced twice: up front against the declared `size`, and again at `/complete` against the object actually stored (oversized objects are deleted and rejected with `413`). Every presign also carries the cap, so the adapter rejects the write itself — an S3 `POST` policy or, for the built-in store, the transfer route. Presigned URLs are valid for 15 minutes.

Downloads work the same way in reverse: `GET /tickets/:id/attachments/:attId` authorizes the request and responds `302` to a short-lived presigned URL that serves the bytes with a `content-disposition` naming the file, so `<a href download>` and `fetch` both work unchanged.

## Quickstart

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
    userIsAgent: (user) => user.email?.endsWith("@agents.example.com") ?? false, // seed agents by predicate (email is null when unavailable)
    managementApiKey: process.env.MANAGEMENT_API_KEY, // enables the management API
    availableTags: ["billing", "bug", "question"],
    maxAttachmentBytes: 5 * 1024 * 1024,
  },
});

// Pass the mount path as `basePath`; it's stripped before routing.
const handler = service.createHandler({ basePath: "/api/servicedesk" });
const route = (request: Request) => handler.handle(request);
```

`createHandler` also exposes an OpenAPI reference at `/reference` by default; pass `{ openApi: false }` to disable it.

See [`ServiceDeskConfig`](./src/types.ts) for the full configuration surface. `createSpindesk` also takes an optional metadata type argument — `createSpindesk<MyMeta>({ … })` — covered in [Typed ticket metadata](#typed-ticket-metadata).

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
| `POST`   | `/tickets/:id/attachments`        | Start an upload; returns a presigned URL. |
| `POST`   | `/tickets/:id/attachments/:attId/complete` | Confirm the upload and publish it. |
| `GET`    | `/tickets/:id/attachments`        | List a ticket's attachments.         |
| `GET`    | `/tickets/:id/attachments/:attId` | Download an attachment (`302` to a presigned URL). |
| `DELETE` | `/tickets/:id/attachments/:attId` | Delete an attachment.                |
| `PATCH`  | `/users/:id/role`                 | Set a user's role (agents only).     |

### Management API

Configure a `managementApiKey` to enable a trusted backend to call the API without a better-auth session. The key is sent as an `Authorization: Bearer <key>` token; when no key is configured, the entire management surface returns `401`.

| Method | Path                 | Description                             |
| ------ | -------------------- | --------------------------------------- |
| `POST` | `/management/agents` | Promote a user to agent by id or email. |

#### Acting on behalf of a user (impersonation)

To operate on any user's behalf, send the management key together with an `x-impersonate-user-id: <userId>` header (exported as `IMPERSONATION_HEADER`) on **any** endpoint in the table above. The request then runs exactly as if that user had made it — with that user's own role — so a plain user's requests are scoped to their own tickets and barred from agent-only fields, while impersonating an agent grants agent powers. This is the way to create tickets, upload attachments, comment, etc. for a user; no dedicated management endpoints are needed.

```ts
import { IMPERSONATION_HEADER } from "@spindesk/core";

await fetch("/api/servicedesk/tickets", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: `Bearer ${managementApiKey}`,
    [IMPERSONATION_HEADER]: userId,
  },
  body: JSON.stringify({ subject: "…", description: "…" }),
});
```

## Type-safe client

`@spindesk/core/client` wraps better-call's typed client with Spindesk's router types. The client is built in two steps — an empty first call reserves the optional metadata type argument (see below); the second takes the options:

```ts
import { createSpindeskClient } from "@spindesk/core/client";

const client = createSpindeskClient()({
  baseURL: "/api/servicedesk",
  credentials: "include",
});
```

## Typed ticket metadata

Every ticket carries a free-form `metadata` object — opaque key/value data the host supplies (e.g. `{ source: "email", priority: 3 }`). It round-trips through the create and update bodies and every ticket response, and defaults to `{}` when absent. By default it's typed as an open `Record<string, unknown>` with no runtime validation. If your host uses a consistent shape, there are two ways to pin it.

### With a config schema (typed **and** validated)

Pass any [Standard Schema](https://standardschema.dev) (Zod, Valibot, ArkType, …) as `config.metadataSchema`. Spindesk **infers** the metadata type from it — no type argument — and validates `metadata` on create/update at runtime, rejecting bad payloads with `400`:

```ts
import { z } from "zod";

const metadataSchema = z.object({
  source: z.enum(["email", "web", "chat"]),
  priority: z.number(),
});

// `metadata` is typed as { source: …; priority: number } on the server,
// and invalid metadata is rejected at runtime.
const service = createSpindesk({ database, config: { auth, metadataSchema } });
```

A configured schema is treated as a guarantee, so metadata is validated on create and **required** — creating a ticket without it is a `400`, unless the schema accepts `{}` (in which case the caller may omit the field). Make your fields optional (or otherwise accept `{}`) if tickets may legitimately lack metadata. Updates are patches: `metadata` is validated only when included.

### With a type argument (types only)

If you only want compile-time types and no runtime validation, pass a type argument instead — no schema value required:

```ts
interface TicketMeta {
  source: "email" | "web" | "chat";
  priority: number;
}

const service = createSpindesk<TicketMeta>({ database, config });
```

### On the client

The client is built separately from the server and can't see its config, so pin the metadata type on it explicitly with the **same** shape (curried — see [Type-safe client](#type-safe-client)):

```ts
const client = createSpindeskClient<TicketMeta>()({
  baseURL: "/api/servicedesk",
  credentials: "include",
});

const { data } = await client("/tickets/:id", { params: { id } });
data?.metadata.priority; // number
await client("@post/tickets", {
  body: { subject: "s", description: "d", metadata: { source: "web", priority: 1 } },
});
```

Both server forms and the client default to an open `Record<string, unknown>`, so untyped usage is unchanged. The type argument is a compile-time view you vouch for; only `config.metadataSchema` adds runtime enforcement.

## License

MIT
