# spindesk

An embeddable service desk API you mount inside your own app — no external services, your database, your auth, your UI.

Spindesk gives you the ticketing logic (tickets, comments, attachments, roles, tagging) as a web-standard request handler. You own the tables and the front end.

## Packages

| Package                                | Description                                                 |
| -------------------------------------- | ----------------------------------------------------------- |
| [`@spindesk/core`](./packages/core)    | The embeddable service desk API, built on [futonic](https://github.com/isaacwasserman/futonic). |
| [`apps/demo`](./apps/demo)             | A reference host: better-auth + bun:sqlite + a React UI.    |

See [`packages/core/README.md`](./packages/core/README.md) for installation, the database schema, mounting, and the API surface.

## Development

This is a [Bun](https://bun.sh) workspace monorepo.

```sh
bun install       # install workspace deps
bun run dev       # run the demo app (apps/demo)
bun run build     # build @spindesk/core
bun run test      # run the test suite
bun run typecheck # type-check @spindesk/core
bun run lint      # biome check
bun run format    # biome format
```

Releases are managed with [changesets](https://github.com/changesets/changesets).

## License

MIT
