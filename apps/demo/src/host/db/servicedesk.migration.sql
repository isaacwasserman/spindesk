CREATE TABLE IF NOT EXISTS servicedesk_users (
  id TEXT PRIMARY KEY NOT NULL,
  role TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS servicedesk_tickets (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL,
  assignee_id TEXT,
  tags TEXT, -- JSON array of tags, e.g. ["billing","urgent"]
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS servicedesk_attachments (
  id TEXT PRIMARY KEY NOT NULL,
  ticket_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  data BLOB NOT NULL,
  uploaded_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (ticket_id) REFERENCES servicedesk_tickets(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS servicedesk_comments (
  id TEXT PRIMARY KEY NOT NULL,
  ticket_id TEXT NOT NULL,
  parent_id TEXT,
  author_id TEXT NOT NULL,
  author_role TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (ticket_id) REFERENCES servicedesk_tickets(id) ON DELETE CASCADE,
  FOREIGN KEY (parent_id) REFERENCES servicedesk_comments(id) ON DELETE CASCADE
);