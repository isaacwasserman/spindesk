CREATE TABLE IF NOT EXISTS spindesk_users (
  id TEXT PRIMARY KEY NOT NULL,
  role TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS spindesk_tickets (
  id TEXT PRIMARY KEY NOT NULL,
  number INTEGER NOT NULL UNIQUE,
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
  data BLOB NOT NULL,
  uploaded_by TEXT NOT NULL,
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
  updated_at TEXT,
  FOREIGN KEY (ticket_id) REFERENCES spindesk_tickets(id) ON DELETE CASCADE,
  FOREIGN KEY (parent_id) REFERENCES spindesk_comments(id) ON DELETE CASCADE
);

-- Denormalized activity log; no FKs so it outlives the rows it references.
CREATE TABLE IF NOT EXISTS spindesk_activities (
  id TEXT PRIMARY KEY NOT NULL,
  type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_role TEXT NOT NULL,
  ticket_id TEXT,
  comment_id TEXT,
  attachment_id TEXT,
  user_id TEXT,
  data TEXT, -- JSON object of variant-specific payload
  created_at TEXT NOT NULL
);