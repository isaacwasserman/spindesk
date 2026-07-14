import type { ServiceDBSchema } from "futonic";

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
				// Monotonic, per-service human-facing key (#1, #2, ...); unique
				// alternative to the UUID `id`. Assigned on insert.
				number: { type: "integer" },
				userId: { type: "string" },
				subject: { type: "string" },
				description: { type: "string" },
				status: { type: "string" },
				assigneeId: { type: "string", optional: true },
				// JSON array of tags (e.g. ["billing","urgent"]); kept
				// denormalized so Lucene filters map to a single column.
				// Stored as JSON text on SQLite/MySQL, jsonb on Postgres.
				tags: { type: "json", optional: true },
				// Arbitrary host-supplied key/value metadata (e.g.
				// {source:"email",priority:3}); opaque to the service.
				// Stored as JSON text on SQLite/MySQL, jsonb on Postgres.
				metadata: { type: "json", optional: true },
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
				// Set when the comment is edited; null/absent for never-edited comments.
				updatedAt: { type: "string", optional: true },
			},
		},
		// Denormalized activity log: one row per ticketing activity (created,
		// updated, commented, ...). No FKs — the log outlives the rows it
		// references. Each row fills only the id columns its activity type has;
		// variant-specific payload lands in the opaque JSON `data` column.
		activities: {
			name: "activities",
			columns: {
				id: { type: "string", primaryKey: true },
				type: { type: "string" },
				actorId: { type: "string" },
				actorRole: { type: "string" },
				ticketId: { type: "string", optional: true },
				commentId: { type: "string", optional: true },
				attachmentId: { type: "string", optional: true },
				userId: { type: "string", optional: true },
				data: { type: "json", optional: true },
				createdAt: { type: "string" },
			},
		},
	},
} satisfies ServiceDBSchema;

export type ServiceDeskSchema = typeof serviceDeskSchema;
