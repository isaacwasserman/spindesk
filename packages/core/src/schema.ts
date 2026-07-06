import type { ServiceDBSchema } from "futonic";

/**
 * Service-desk database schema.
 *
 * futonic prefixes every table with the service id, so these become
 * `servicedesk_users`, `servicedesk_tickets`, and `servicedesk_comments`
 * in the host's database — no collisions with host or sibling-service tables.
 */
export const serviceDeskSchema = {
	tables: {
		// Sidecar user info, keyed by the better-auth user id. Holds only the
		// service-desk-specific bits the host's auth doesn't know about (role).
		users: {
			fields: {
				id: { type: "string", primaryKey: true, required: true },
				role: {
					type: "string",
					required: true,
					enum: ["user", "agent"],
				},
				created_at: { type: "date", required: true },
			},
		},
		tickets: {
			fields: {
				id: { type: "string", primaryKey: true, required: true },
				user_id: { type: "string", required: true },
				subject: { type: "string", required: true },
				description: { type: "string", required: true },
				status: {
					type: "string",
					required: true,
					enum: ["open", "pending", "resolved", "closed"],
				},
				assignee_id: { type: "string" },
				// JSON array of tags (e.g. ["billing","urgent"]); kept
				// denormalized so Lucene filters map to a single column.
				// Stored as JSON text on SQLite/MySQL, jsonb on Postgres.
				tags: { type: "json" },
				// Set when the author archives the ticket; hides it from
				// default listings.
				archived_at: { type: "date" },
				created_at: { type: "date", required: true },
				updated_at: { type: "date", required: true },
			},
		},
		// Ticket file attachments. `data` holds the raw bytes (BYTEA in
		// Postgres, BLOB in SQLite/MySQL).
		attachments: {
			fields: {
				id: { type: "string", primaryKey: true, required: true },
				ticket_id: {
					type: "string",
					required: true,
					references: {
						model: "tickets",
						field: "id",
						onDelete: "cascade",
					},
				},
				filename: { type: "string", required: true },
				content_type: { type: "string", required: true },
				size: { type: "number", required: true },
				data: { type: "binary", required: true },
				uploaded_by: { type: "string", required: true },
				created_at: { type: "date", required: true },
			},
		},
		comments: {
			fields: {
				id: { type: "string", primaryKey: true, required: true },
				ticket_id: {
					type: "string",
					required: true,
					references: {
						model: "tickets",
						field: "id",
						onDelete: "cascade",
					},
				},
				// Parent comment for threaded replies; null for top-level
				// comments. Self-referential FK, cascades on parent delete.
				parent_id: {
					type: "string",
					references: {
						model: "comments",
						field: "id",
						onDelete: "cascade",
					},
				},
				author_id: { type: "string", required: true },
				// Snapshot of the author's role at write time, for display.
				author_role: { type: "string", required: true },
				body: { type: "string", required: true },
				created_at: { type: "date", required: true },
			},
		},
	},
} satisfies ServiceDBSchema;

export type ServiceDeskSchema = typeof serviceDeskSchema;
