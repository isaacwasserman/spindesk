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
import { servicedesk } from "@spindesk/core";

const service = servicedesk({
	mount: "/api/servicedesk",
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

## License

MIT
