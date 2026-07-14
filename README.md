# spindesk

**An embeddable service desk API you mount inside your own app — no external services, your database, your auth, your UI.**

> Looking for how to install, mount, or call it? The usage reference lives in the package README: **[`packages/core/README.md`](./packages/core/README.md)**.

Spindesk gives you the ticketing logic — tickets, comments, attachments, roles, tagging, and typed per-ticket metadata — as a web-standard request handler. You own the tables and the front end. It's built on [futonic](https://github.com/isaacwasserman/futonic), which embeds services into a host app instead of deploying them alongside it.

- **No external services** — runs in-process inside your app; no extra containers or network hops.
- **Your database** — Postgres, MySQL, or SQLite; you own the tables and DDL.
- **Your auth** — plugs into the auth you already run, with [better-auth](https://better-auth.com) as a first-class citizen.
- **Your UI** — Spindesk is the logic plus a fully typed client; the front end is yours.

## Packages

This is a [Bun](https://bun.sh) workspace monorepo.

| Package | Description |
| --- | --- |
| [`@spindesk/core`](./packages/core) | The embeddable service desk API. Published to npm; its [README](./packages/core/README.md) covers install, the database schema, mounting, the API surface, the typed client, and typed metadata. |
| [`apps/demo`](./apps/demo) | A reference host wiring it all together: better-auth + bun:sqlite + a React UI. |

## Development

```sh
bun install       # install workspace deps
bun run dev       # run the demo app (apps/demo)
bun run build     # build @spindesk/core
bun run test      # run the test suite
bun run typecheck # type-check @spindesk/core
bun run lint      # biome check
bun run format    # biome format
```

Releases are managed with [changesets](https://github.com/changesets/changesets): add one with `bunx changeset` describing any user-facing change.

## License

MIT
