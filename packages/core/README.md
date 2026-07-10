# @spindesk/core

An embeddable service desk API built on [futonic](https://github.com/isaacwasserman/futonic).

Host applications can create the required tables in their database and mount Spindesk as a route handler in any web standard Javascript app.

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

Spindesk uses the database your application already has. That means you own the tables and the DDL to create them. Spindesk ships a dialect-agnostic schema for the required tables where the types have different mappings in different dialects.

[INSERT TYPE MAPPING]

Using the mappings above, create the following tables in your database:

[INSERT SCHEMA]


## Instantiation and Mounting

```ts
import { db } from "your-database";
import { servicedesk } from "@spindesk/core";

const service = servicedesk({
	mount: "/api/servicedesk",  // where on your api the Spindesk API will be mounted
	database: db,  // Your database driver
	config: {
		auth, // your better-auth instance (or interface compatible adapter)
		agentUserIds: ["..."],  // users seeded with the "agent" role
		availableTags: ["billing", "bug", "question"],
		maxAttachmentBytes: 5 * 1024 * 1024,
	},
});

await service.init();

// Pass the mount path as `basePath`; it's stripped before routing.
const handler = (request: Request) =>
	service.handler(request, { basePath: "/api/servicedesk" });

```

See [`ServiceDeskConfig`](./src/types.ts) for the full configuration surface.

## License

MIT
