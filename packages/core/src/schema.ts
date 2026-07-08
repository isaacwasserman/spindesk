import type { ServiceDBSchema } from "futonic";

/**
 * Service id. futonic prefixes it onto every physical table name (via a runtime
 * `TablePrefixPlugin` on `svc.db`, and in the generated drizzle schema), so
 * these tables land in the host database as `servicedesk_*` with no collisions.
 */
export const serviceDeskId = "servicedesk";

/**
 * Service-desk database schema (futonic's dialect-agnostic `ServiceDBSchema`).
 *
 * Table and column keys are the logical (camelCase) names endpoints query
 * against `svc.db` — e.g. `db.selectFrom("tickets")`, `where("userId", ...)`.
 * futonic's `CamelCasePlugin` + `TablePrefixPlugin` rewrite those to the
 * physical snake_case, service-prefixed identifiers (`servicedesk_tickets`,
 * `user_id`) at query time, so the prefix never appears in this file.
 *
 * Columns are NOT NULL unless marked `optional`. Timestamps are stored as ISO
 * `string`s (TEXT), matching the hand-maintained host migration.
 */
export const serviceDeskSchema = {
	tables: {
		// Sidecar user info, keyed by the better-auth user id. Holds only the
		// service-desk-specific bits the host's auth doesn't know about (role).
		users: {
			name: "users",
			columns: {
				id: { type: "string", primaryKey: true },
				role: { type: "string" },
				createdAt: { type: "string" },
			},
		},
		tickets: {
			name: "tickets",
			columns: {
				id: { type: "string", primaryKey: true },
				userId: { type: "string" },
				subject: { type: "string" },
				description: { type: "string" },
				status: { type: "string" },
				assigneeId: { type: "string", optional: true },
				// JSON array of tags (e.g. ["billing","urgent"]); kept
				// denormalized so Lucene filters map to a single column.
				// Stored as JSON text on SQLite/MySQL, jsonb on Postgres.
				tags: { type: "json", optional: true },
				// Set when the author archives the ticket; hides it from
				// default listings.
				archivedAt: { type: "string", optional: true },
				createdAt: { type: "string" },
				updatedAt: { type: "string" },
			},
		},
		// Ticket file attachments. `data` holds the raw bytes (BYTEA in
		// Postgres, BLOB in SQLite/MySQL).
		attachments: {
			name: "attachments",
			columns: {
				id: { type: "string", primaryKey: true },
				ticketId: {
					type: "string",
					references: {
						table: "tickets",
						column: "id",
						onDelete: "cascade",
					},
				},
				filename: { type: "string" },
				contentType: { type: "string" },
				size: { type: "integer" },
				data: { type: "blob" },
				uploadedBy: { type: "string" },
				createdAt: { type: "string" },
			},
		},
		comments: {
			name: "comments",
			columns: {
				id: { type: "string", primaryKey: true },
				ticketId: {
					type: "string",
					references: {
						table: "tickets",
						column: "id",
						onDelete: "cascade",
					},
				},
				// Parent comment for threaded replies; null for top-level
				// comments. Self-referential FK, cascades on parent delete.
				parentId: {
					type: "string",
					optional: true,
					references: {
						table: "comments",
						column: "id",
						onDelete: "cascade",
					},
				},
				authorId: { type: "string" },
				// Snapshot of the author's role at write time, for display.
				authorRole: { type: "string" },
				body: { type: "string" },
				createdAt: { type: "string" },
			},
		},
	},
} satisfies ServiceDBSchema;

export type ServiceDeskSchema = typeof serviceDeskSchema;
