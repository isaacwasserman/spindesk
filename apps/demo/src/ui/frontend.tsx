import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { FilterBar } from "./FilterBar";
import {
	type Attachment,
	authClient,
	client,
	type Comment,
	downloadUrl,
	type Role,
	type Ticket,
	type TicketStatus,
} from "./api";

const PAGE_SIZE = 10;

/** Fetch the configured tag vocabulary once. */
function useAvailableTags(): string[] {
	const [tags, setTags] = useState<string[]>([]);
	useEffect(() => {
		client("/tags").then((r) => setTags(r.tags)).catch(() => {});
	}, []);
	return tags;
}

/** Checkbox group for picking tags from the configured vocabulary. */
function TagPicker({
	available,
	selected,
	onChange,
}: {
	available: string[];
	selected: string[];
	onChange: (tags: string[]) => void;
}) {
	if (available.length === 0) {
		return <span className="muted">no tags configured</span>;
	}
	return (
		<div className="row" style={{ flexWrap: "wrap" }}>
			{available.map((t) => (
				<label
					key={t}
					style={{ display: "inline-flex", gap: 4, width: "auto" }}
				>
					<input
						type="checkbox"
						style={{ width: "auto" }}
						checked={selected.includes(t)}
						onChange={(e) =>
							onChange(
								e.target.checked
									? [...selected, t]
									: selected.filter((x) => x !== t),
							)
						}
					/>
					{t}
				</label>
			))}
		</div>
	);
}

function TagChips({ tags }: { tags: string[] }) {
	if (!tags.length) return null;
	return (
		<span className="row" style={{ display: "inline-flex", gap: 4 }}>
			{tags.map((t) => (
				<span key={t} className="badge">
					{t}
				</span>
			))}
		</span>
	);
}

const STATUSES: TicketStatus[] = ["open", "pending", "resolved", "closed"];

/** Prefer a display name; fall back to a shortened id. */
const who = (name: string | null | undefined, id: string) =>
	name || id.slice(0, 8);

/**
 * Renders a flat comment list as a reply tree. Each comment nests under its
 * `parentId`; depth drives indentation. Unlimited nesting.
 */
function renderThread(
	comments: Comment[],
	parentId: string | null,
	depth: number,
	onReply: (c: Comment) => void,
): React.ReactNode {
	const children = comments.filter((c) => c.parentId === parentId);
	return children.map((c) => (
		<div key={c.id} style={{ marginLeft: depth ? 16 : 0 }}>
			<div className={`comment ${c.authorRole}`}>
				<div className="muted">
					<span className={`badge ${c.authorRole}`}>{c.authorRole}</span>{" "}
					{who(c.authorName, c.authorId)} ·{" "}
					{new Date(c.createdAt).toLocaleString()}
				</div>
				<div>{c.body}</div>
				<button className="link" onClick={() => onReply(c)}>
					Reply
				</button>
			</div>
			{renderThread(comments, c.id, depth + 1, onReply)}
		</div>
	));
}

function useAsyncError() {
	const [error, setError] = useState<string | null>(null);
	const run = async (fn: () => Promise<unknown>) => {
		setError(null);
		try {
			await fn();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	};
	return { error, setError, run };
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

function AuthForm() {
	const [mode, setMode] = useState<"sign-in" | "sign-up">("sign-in");
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [name, setName] = useState("");
	const { error, setError, run } = useAsyncError();
	const [busy, setBusy] = useState(false);

	const submit = (e: React.FormEvent) => {
		e.preventDefault();
		setBusy(true);
		run(async () => {
			const res =
				mode === "sign-up"
					? await authClient.signUp.email({ email, password, name })
					: await authClient.signIn.email({ email, password });
			if (res.error) throw new Error(res.error.message || "Auth failed");
		}).finally(() => setBusy(false));
	};

	return (
		<div className="app">
			<h1>Service Desk</h1>
			<form className="card" onSubmit={submit}>
				<div className="row spread">
					<strong>{mode === "sign-up" ? "Create account" : "Sign in"}</strong>
					<button
						type="button"
						className="link"
						onClick={() => {
							setError(null);
							setMode(mode === "sign-up" ? "sign-in" : "sign-up");
						}}
					>
						{mode === "sign-up" ? "Have an account? Sign in" : "New? Sign up"}
					</button>
				</div>
				{mode === "sign-up" && (
					<>
						<label>Name</label>
						<input value={name} onChange={(e) => setName(e.target.value)} required />
					</>
				)}
				<label>Email</label>
				<input
					type="email"
					value={email}
					onChange={(e) => setEmail(e.target.value)}
					required
				/>
				<label>Password</label>
				<input
					type="password"
					value={password}
					onChange={(e) => setPassword(e.target.value)}
					required
					minLength={8}
				/>
				{error && <p className="err">{error}</p>}
				<div className="row" style={{ marginTop: "0.6rem" }}>
					<button className="primary" disabled={busy} type="submit">
						{mode === "sign-up" ? "Sign up" : "Sign in"}
					</button>
				</div>
			</form>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Tickets
// ---------------------------------------------------------------------------

function NewTicket({
	availableTags,
	onCreated,
}: {
	availableTags: string[];
	onCreated: () => void;
}) {
	const [subject, setSubject] = useState("");
	const [description, setDescription] = useState("");
	const [tags, setTags] = useState<string[]>([]);
	const [open, setOpen] = useState(false);
	const { error, run } = useAsyncError();

	if (!open) {
		return (
			<button className="primary" onClick={() => setOpen(true)}>
				+ New ticket
			</button>
		);
	}
	return (
		<form
			className="card"
			onSubmit={(e) => {
				e.preventDefault();
				run(async () => {
					await client("@post/tickets", {
						body: { subject, description, tags },
					});
					setSubject("");
					setDescription("");
					setTags([]);
					setOpen(false);
					onCreated();
				});
			}}
		>
			<label>Subject</label>
			<input value={subject} onChange={(e) => setSubject(e.target.value)} required />
			<label>Description</label>
			<textarea
				rows={3}
				value={description}
				onChange={(e) => setDescription(e.target.value)}
				required
			/>
			<label>Tags</label>
			<TagPicker available={availableTags} selected={tags} onChange={setTags} />
			{error && <p className="err">{error}</p>}
			<div className="row" style={{ marginTop: "0.6rem" }}>
				<button className="primary" type="submit">
					Create
				</button>
				<button type="button" onClick={() => setOpen(false)}>
					Cancel
				</button>
			</div>
		</form>
	);
}

function TicketList({
	role,
	availableTags,
	onOpen,
}: {
	role: Role;
	availableTags: string[];
	onOpen: (id: string) => void;
}) {
	const [tickets, setTickets] = useState<Ticket[]>([]);
	const [total, setTotal] = useState(0);
	const [offset, setOffset] = useState(0);
	// Applied Lucene filter (the FilterBar owns the live draft + completions).
	const [query, setQuery] = useState("");
	const { error, run } = useAsyncError();

	const load = () =>
		run(async () => {
			const page = await client("/tickets", {
				query: { q: query, limit: String(PAGE_SIZE), offset: String(offset) },
			});
			setTickets(page.tickets);
			setTotal(page.total);
		});

	// biome-ignore lint/correctness/useExhaustiveDependencies: reload on query/page change
	useEffect(() => {
		load();
	}, [query, offset]);

	return (
		<div>
			<div className="row spread">
				<NewTicket availableTags={availableTags} onCreated={load} />
			</div>

			<FilterBar
				availableTags={availableTags}
				onApply={(q) => {
					setOffset(0);
					setQuery(q);
				}}
			/>

			{error && <p className="err">{error}</p>}
			<p className="muted">
				{role === "agent" ? "All tickets" : "Your tickets"} · {total} total
			</p>
			{tickets.map((t) => (
				<div className="card" key={t.id}>
					<div className="row spread">
						<button className="link" onClick={() => onOpen(t.id)}>
							{t.subject}
						</button>
						<span className={`status ${t.status}`}>{t.status}</span>
					</div>
					<p className="muted">
						#{t.id.slice(0, 8)}
						{role === "agent" ? ` · by ${who(t.userName, t.userId)}` : ""} ·
						updated {new Date(t.updatedAt).toLocaleString()}
						{t.assigneeId
							? ` · assignee ${who(t.assigneeName, t.assigneeId)}`
							: ""}{" "}
						<TagChips tags={t.tags} />
					</p>
				</div>
			))}
			{tickets.length === 0 && !error && <p className="muted">No tickets.</p>}

			<div className="row spread">
				<button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>
					← Prev
				</button>
				<span className="muted">
					{total === 0 ? 0 : offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of {total}
				</span>
				<button
					disabled={offset + PAGE_SIZE >= total}
					onClick={() => setOffset(offset + PAGE_SIZE)}
				>
					Next →
				</button>
			</div>
		</div>
	);
}

/** Attachment list + streamed upload/download/delete for a ticket. */
function Attachments({
	ticketId,
	canModify,
}: {
	ticketId: string;
	canModify: boolean;
}) {
	const [items, setItems] = useState<Attachment[]>([]);
	const [busy, setBusy] = useState(false);
	const { error, run } = useAsyncError();

	const load = () =>
		run(async () => {
			const { attachments } = await client("/tickets/:id/attachments", {
				params: { id: ticketId },
			});
			setItems(attachments);
		});

	// biome-ignore lint/correctness/useExhaustiveDependencies: load per ticket
	useEffect(() => {
		load();
	}, [ticketId]);

	const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
		const file = e.target.files?.[0];
		e.target.value = ""; // allow re-selecting the same file
		if (!file) return;
		setBusy(true);
		run(async () => {
			await client("@post/tickets/:id/attachments", {
				params: { id: ticketId },
				// biome-ignore lint/suspicious/noExplicitAny: raw streamed body (endpoint sets `disableBody`)
				body: file as any,
				headers: {
					"x-filename": file.name,
					"content-type": file.type || "application/octet-stream",
				},
			});
			await load();
		}).finally(() => setBusy(false));
	};

	const fmtSize = (n: number) =>
		n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;

	return (
		<div className="card">
			<div className="row spread">
				<strong>Attachments ({items.length})</strong>
				<label className="link" style={{ width: "auto" }}>
					{busy ? "Uploading…" : "+ Upload"}
					<input
						type="file"
						style={{ display: "none" }}
						disabled={busy}
						onChange={onFile}
					/>
				</label>
			</div>
			{error && <p className="err">{error}</p>}
			{items.map((a) => (
				<div className="row spread" key={a.id}>
					<a href={downloadUrl(ticketId, a.id)} download>
						{a.filename}
					</a>
					<span className="muted">
						{fmtSize(a.size)}
						{canModify && (
							<button
								type="button"
								className="link"
								style={{ marginLeft: 8 }}
								onClick={() =>
									run(async () => {
										await client("@delete/tickets/:id/attachments/:attId", {
											params: { id: ticketId, attId: a.id },
										});
										await load();
									})
								}
							>
								delete
							</button>
						)}
					</span>
				</div>
			))}
			{items.length === 0 && <p className="muted">No attachments.</p>}
		</div>
	);
}

function TicketDetail({
	id,
	role,
	meId,
	availableTags,
	onBack,
}: {
	id: string;
	role: Role;
	meId: string;
	availableTags: string[];
	onBack: () => void;
}) {
	const [ticket, setTicket] = useState<Ticket | null>(null);
	const [comments, setComments] = useState<Comment[]>([]);
	const [body, setBody] = useState("");
	const [assignee, setAssignee] = useState("");
	const [replyTo, setReplyTo] = useState<{ id: string; name: string } | null>(
		null,
	);
	// Edit mode (author/agent): local drafts for subject/description/tags.
	const [editing, setEditing] = useState(false);
	const [editSubject, setEditSubject] = useState("");
	const [editDescription, setEditDescription] = useState("");
	const [editTags, setEditTags] = useState<string[]>([]);
	const { error, run } = useAsyncError();

	const load = () =>
		run(async () => {
			const [t, c] = await Promise.all([
				client("/tickets/:id", { params: { id } }),
				client("/tickets/:id/comments", { params: { id } }),
			]);
			setTicket(t);
			setComments(c.comments);
			setAssignee(t.assigneeId ?? "");
		});

	const startEdit = (t: Ticket) => {
		setEditSubject(t.subject);
		setEditDescription(t.description);
		setEditTags(t.tags);
		setEditing(true);
	};

	// biome-ignore lint/correctness/useExhaustiveDependencies: load once per ticket
	useEffect(() => {
		load();
	}, [id]);

	if (!ticket) {
		return (
			<div>
				<button className="link" onClick={onBack}>
					← Back
				</button>
				{error ? <p className="err">{error}</p> : <p className="muted">Loading…</p>}
			</div>
		);
	}

	const setStatus = (status: TicketStatus) =>
		run(async () => {
			await client("@patch/tickets/:id", { params: { id }, body: { status } });
			await load();
		});

	// Owners may only open/close; agents get every status.
	const ownerStatuses: TicketStatus[] =
		ticket.status === "closed" ? ["open"] : ["closed"];
	const statusOptions = role === "agent" ? STATUSES : ownerStatuses;
	const canEdit = role === "agent" || ticket.userId === meId;

	const saveEdit = () =>
		run(async () => {
			await client("@patch/tickets/:id", {
				params: { id },
				body: {
					subject: editSubject,
					description: editDescription,
					tags: editTags,
				},
			});
			setEditing(false);
			await load();
		});
	const toggleArchive = () =>
		run(async () => {
			await client("@patch/tickets/:id", {
				params: { id },
				body: { archived: !ticket.archivedAt },
			});
			await load();
		});

	return (
		<div>
			<button className="link" onClick={onBack}>
				← Back
			</button>
			<div className="card">
				{editing ? (
					<>
						<label>Subject</label>
						<input
							value={editSubject}
							onChange={(e) => setEditSubject(e.target.value)}
						/>
						<label>Description</label>
						<textarea
							rows={3}
							value={editDescription}
							onChange={(e) => setEditDescription(e.target.value)}
						/>
						<label>Tags</label>
						<TagPicker
							available={availableTags}
							selected={editTags}
							onChange={setEditTags}
						/>
						<div className="row" style={{ marginTop: "0.6rem" }}>
							<button className="primary" onClick={saveEdit}>
								Save
							</button>
							<button onClick={() => setEditing(false)}>Cancel</button>
						</div>
					</>
				) : (
					<>
						<div className="row spread">
							<h1 style={{ fontSize: "1.1rem" }}>
								{ticket.subject}{" "}
								{ticket.archivedAt && <span className="badge">archived</span>}
							</h1>
							<span className={`status ${ticket.status}`}>{ticket.status}</span>
						</div>
						<p>{ticket.description}</p>
						<p className="muted">
							#{ticket.id.slice(0, 8)} · opened by{" "}
							{who(ticket.userName, ticket.userId)} ·{" "}
							{new Date(ticket.createdAt).toLocaleString()}
							{ticket.assigneeId
								? ` · assignee ${who(ticket.assigneeName, ticket.assigneeId)}`
								: ""}{" "}
							<TagChips tags={ticket.tags} />
						</p>
						{canEdit && (
							<div className="row" style={{ marginTop: "0.4rem" }}>
								<button onClick={() => startEdit(ticket)}>Edit</button>
								<button onClick={toggleArchive}>
									{ticket.archivedAt ? "Unarchive" : "Archive"}
								</button>
							</div>
						)}
					</>
				)}

				<div className="row" style={{ marginTop: "0.4rem" }}>
					{statusOptions.map((s) => (
						<button key={s} onClick={() => setStatus(s)}>
							Mark {s}
						</button>
					))}
				</div>

				{role === "agent" && (
					<div className="row" style={{ marginTop: "0.6rem" }}>
						<input
							style={{ maxWidth: 320 }}
							placeholder="assignee user id"
							value={assignee}
							onChange={(e) => setAssignee(e.target.value)}
						/>
						<button
							onClick={() =>
								run(async () => {
									await client("@patch/tickets/:id", {
										params: { id },
										body: { assigneeId: assignee || null },
									});
									await load();
								})
							}
						>
							Assign
						</button>
					</div>
				)}
			</div>

			<Attachments ticketId={id} canModify={canEdit} />

			<h1 style={{ fontSize: "1rem" }}>Conversation</h1>
			{comments.length === 0 ? (
				<p className="muted">No comments yet.</p>
			) : (
				renderThread(comments, null, 0, (c) =>
					setReplyTo({ id: c.id, name: who(c.authorName, c.authorId) }),
				)
			)}

			<form
				className="card"
				onSubmit={(e) => {
					e.preventDefault();
					run(async () => {
						await client("@post/tickets/:id/comments", {
							params: { id },
							body: { body, parentId: replyTo?.id ?? null },
						});
						setBody("");
						setReplyTo(null);
						await load();
					});
				}}
			>
				<div className="row spread">
					<label>
						{replyTo ? `Replying to ${replyTo.name}` : "Add a comment"}
					</label>
					{replyTo && (
						<button
							type="button"
							className="link"
							onClick={() => setReplyTo(null)}
						>
							cancel
						</button>
					)}
				</div>
				<textarea
					rows={2}
					value={body}
					onChange={(e) => setBody(e.target.value)}
					required
				/>
				<div className="row" style={{ marginTop: "0.5rem" }}>
					<button className="primary" type="submit">
						Send
					</button>
				</div>
			</form>
			{error && <p className="err">{error}</p>}
		</div>
	);
}

function AgentAdmin() {
	const [userId, setUserId] = useState("");
	const [role, setRole] = useState<Role>("agent");
	const [msg, setMsg] = useState<string | null>(null);
	const { error, setError, run } = useAsyncError();

	return (
		<details className="card">
			<summary>Agent tools · manage roles</summary>
			<form
				onSubmit={(e) => {
					e.preventDefault();
					setMsg(null);
					run(async () => {
						const r = await client("@patch/users/:id/role", {
							params: { id: userId },
							body: { role },
						});
						setMsg(`${r.id} is now ${r.role}`);
					});
				}}
			>
				<label>User id</label>
				<input value={userId} onChange={(e) => setUserId(e.target.value)} required />
				<label>Role</label>
				<select
					style={{ width: "auto" }}
					value={role}
					onChange={(e) => setRole(e.target.value as Role)}
				>
					<option value="user">user</option>
					<option value="agent">agent</option>
				</select>
				<div className="row" style={{ marginTop: "0.5rem" }}>
					<button className="primary" type="submit">
						Update role
					</button>
				</div>
				{msg && <p className="muted">{msg}</p>}
				{error && <p className="err">{error}</p>}
			</form>
		</details>
	);
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

function Dashboard({ email }: { email: string }) {
	const [me, setMe] = useState<{ id: string; role: Role } | null>(null);
	const [view, setView] = useState<{ name: "list" } | { name: "detail"; id: string }>({
		name: "list",
	});

	const availableTags = useAvailableTags();

	useEffect(() => {
		client("/me").then(setMe).catch(() => setMe(null));
	}, []);

	if (!me) return <div className="app">Loading…</div>;

	return (
		<div className="app">
			<header className="bar">
				<h1>Service Desk</h1>
				<div className="row">
					<span className="muted">{email}</span>
					<span className={`badge ${me.role}`}>{me.role}</span>
					<button onClick={() => authClient.signOut()}>Sign out</button>
				</div>
			</header>
			<p className="muted" style={{ marginTop: "-0.5rem" }}>
				Your id: {me.id}
			</p>
			{me.role === "agent" && <AgentAdmin />}
			{view.name === "list" ? (
				<TicketList
					role={me.role}
					availableTags={availableTags}
					onOpen={(id) => setView({ name: "detail", id })}
				/>
			) : (
				<TicketDetail
					id={view.id}
					role={me.role}
					meId={me.id}
					availableTags={availableTags}
					onBack={() => setView({ name: "list" })}
				/>
			)}
		</div>
	);
}

function App() {
	const { data: session, isPending } = authClient.useSession();
	if (isPending) return <div className="app">Loading…</div>;
	if (!session) return <AuthForm />;
	return <Dashboard email={session.user.email} />;
}

createRoot(document.getElementById("root")!).render(<App />);
