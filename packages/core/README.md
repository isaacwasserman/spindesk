# @spindesk/core

An embeddable service desk API built on [futonic](https://github.com/isaacwasserman/futonic).

A host application installs this package and mounts the service: the service
opens its own database tables, builds its own router, and authenticates every
request against a [better-auth](https://better-auth.com) instance the host
provides. The service is **API-only** — the host supplies the UI and creates
the service's tables.

## Install

```sh
bun add @spindesk/core
```

## Usage

```ts
import { Database } from "bun:sqlite";
import { servicedesk } from "@spindesk/core";

const service = servicedesk({
	mount: "/api/servicedesk",
	database: new Database("servicedesk.sqlite"), // required — see "Database" below
	config: {
		auth,                    // your better-auth instance
		agentUserIds: ["..."],  // users seeded with the "agent" role
		availableTags: ["billing", "bug", "question"],
		maxAttachmentBytes: 5 * 1024 * 1024,
	},
});

await service.init();

// route matching requests to the service
const response = await service.handler(request);
```

See [`ServiceDeskConfig`](./src/types.ts) for the full configuration surface.

## Database

The service opens its **own** Kysely instance from the `database` you pass to
`servicedesk({ database })`. This key is **required**. It auto-detects the
dialect from the driver's shape, so pass a raw driver instance or a Kysely
`Dialect` directly:

| You pass | Dialect |
| --- | --- |
| A Bun SQLite `Database` (`bun:sqlite`) | sqlite |
| A `better-sqlite3` instance | sqlite |
| A `pg.Pool` | postgres |
| A `mysql2` pool | mysql |
| Any Kysely `Dialect` instance | as configured |

`init()` opens the connection and runs `onInit` (seeding configured agents).
`shutdown()` calls `kysely.destroy()` by default; pass
`destroyDatabaseOnShutdown: false` when you share one connection across
services. The host is responsible for **creating the service's tables** — the
service does not run migrations.

## License

MIT
