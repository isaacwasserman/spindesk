---
"@spindesk/core": minor
---

Replace the `agentUserIds` and `agentEmails` config lists with a single `userIsAgent: (user: { id: string; email: string | null }) => boolean | Promise<boolean>` predicate. A user is seeded with the `"agent"` role on first sight when the predicate returns true; `email` is `null` when unavailable (e.g. impersonation). This is a breaking change — hosts that used the lists reimplement them inside the predicate (`(u) => ids.includes(u.id) || (u.email != null && emails.includes(u.email))`).
