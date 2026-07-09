/**
 * Demo host wiring: a fresh better-auth + futonic stack over bun:sqlite,
 * exposed as a single `fetch(request)` handler. Kept separate from the
 * `Bun.serve` entrypoint so tests can spin up isolated in-memory instances.
 */
import { Database } from "bun:sqlite";
import { getMigrations } from "better-auth/db/migration";
import { createSpindesk, type SpindeskArgs } from "@spindesk/core";
import { type Auth, createAuth } from "./auth";

/** The raw connection type the service accepts (a Kysely SqliteDatabase, etc). */
type ServiceConnection = SpindeskArgs["database"]["connection"];

/**
 * Service-desk DDL. futonic no longer generates migrations; the host owns its
 * schema, so this is a hand-maintained artifact kept in sync with the service's
 * dbSchema. Statements are idempotent (`CREATE TABLE IF NOT EXISTS`).
 */
const SERVICEDESK_DDL = await Bun.file(
	new URL("./db/servicedesk.migration.sql", import.meta.url),
).text();

/**
 * Wrap bun:sqlite so Kysely's SqliteDialect can tell reader from writer
 * statements. bun:sqlite doesn't set `stmt.reader`, so without this SELECTs
 * come back empty. (Adapted from futonic's host-hono example.)
 */
export function wrapBunSqlite(inner: Database): Database {
	return new Proxy(inner, {
		get(target, prop) {
			if (prop === "prepare") {
				return (sql: string) => {
					const stmt = target.prepare(sql);
					const trimmed = sql.trimStart().toUpperCase();
					const isReader =
						trimmed.startsWith("SELECT") ||
						trimmed.startsWith("WITH") ||
						trimmed.startsWith("PRAGMA");
					const hasReturning = /\bRETURNING\b/i.test(sql);
					return new Proxy(stmt, {
						get(stmtTarget, stmtProp) {
							if (stmtProp === "reader")
								return isReader || hasReturning;
							const val = (stmtTarget as never)[stmtProp];
							return typeof val === "function"
								? (val as (...a: unknown[]) => unknown).bind(
										stmtTarget,
									)
								: val;
						},
					});
				};
			}
			const val = (target as never)[prop];
			return typeof val === "function"
				? (val as (...a: unknown[]) => unknown).bind(target)
				: val;
		},
	}) as Database;
}

export interface CreateAppOptions {
	/** SQLite path; defaults to in-memory (great for tests). */
	dbPath?: string;
	baseURL?: string;
	/** better-auth user ids to seed with the "agent" role. */
	agentUserIds?: string[];
	/** Allowed tag vocabulary passed to the service. */
	availableTags?: string[];
	/** Mount path for the service router. */
	mount?: string;
}

export interface App {
	service: ReturnType<typeof createSpindesk>;
	auth: Auth;
	mount: string;
	/** Handle a request: routes /api/auth/* to better-auth, mount/* to the service. */
	fetch(request: Request): Promise<Response>;
	close(): Promise<void>;
}

export async function createApp(opts: CreateAppOptions = {}): Promise<App> {
	const {
		dbPath = ":memory:",
		baseURL = "http://localhost:3000",
		agentUserIds = [],
		availableTags,
		mount = "/api/servicedesk",
	} = opts;

	const inner = new Database(dbPath);
	inner.exec("PRAGMA journal_mode = WAL");
	inner.exec("PRAGMA foreign_keys = ON");
	const db = wrapBunSqlite(inner);

	// better-auth owns its own tables; create them, then the service's.
	const auth = createAuth(db, baseURL);
	const { runMigrations } = await getMigrations(auth.options);
	await runMigrations();
	inner.exec(SERVICEDESK_DDL);

	// The service opens its own Kysely instance from `database.connection`; hand
	// it the wrapped connection (provider "sqlite") so SqliteDialect gets reader
	// detection. It shares the host's connection, so we (not it) close the db on
	// shutdown. `service.handler` is a web-standard (Request) => Response.
	const service = createSpindesk({
		// `wrapBunSqlite` adds the `reader` flag Kysely's SqliteDialect needs at
		// runtime; the cast bridges bun:sqlite's type to Kysely's SqliteDatabase.
		database: {
			connection: db as unknown as ServiceConnection,
			provider: "sqlite",
		},
		config: { auth, agentUserIds, availableTags },
	});
	const handler = service.handler;

	async function fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const { pathname } = url;
		if (pathname.startsWith("/api/auth")) return auth.handler(request);
		if (pathname === mount || pathname.startsWith(`${mount}/`)) {
			// The service router registers un-prefixed paths (e.g. "/tickets")
			// and has no notion of a mount, so the host strips its own prefix
			// before dispatching.
			url.pathname = pathname.slice(mount.length) || "/";
			return handler(new Request(url, request));
		}
		return new Response(JSON.stringify({ error: "Not found" }), {
			status: 404,
			headers: { "Content-Type": "application/json" },
		});
	}

	return {
		service,
		auth,
		mount,
		fetch,
		async close() {
			inner.close();
		},
	};
}
