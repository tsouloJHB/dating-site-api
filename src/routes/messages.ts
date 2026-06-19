import { sql } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { z } from "zod";

import { createDb } from "@JustHookUps/db";

import { LIST_PAGE_SIZE } from "../constants";
import { expirePremiumIfNeeded } from "../lib/subscription";

/** S4 — chat threads, history, and send (with match-gate for FREE tier). */
export const messages = new Hono();

type AuthSession = {
	user?: { id?: string };
	session?: { user?: { id?: string } };
};

async function getAuthenticatedUserId(c: Context) {
	const origin = new URL(c.req.url).origin;
	const authResponse = await fetch(`${origin}/api/auth/get-session`, {
		method: "GET",
		headers: {
			cookie: c.req.header("cookie") ?? "",
			authorization: c.req.header("authorization") ?? "",
		},
	});
	if (!authResponse.ok) return null;
	const rawPayload = await authResponse.json().catch(() => null);
	const payload =
		rawPayload && typeof rawPayload === "object"
			? (rawPayload as AuthSession)
			: null;
	const userId = payload?.user?.id ?? payload?.session?.user?.id;
	return typeof userId === "string" && userId.length > 0 ? userId : null;
}

// ── GET /threads ──────────────────────────────────────────────────────────────
// Returns one entry per unique conversation partner, last message snippet +
// other user's name + avatar URL, sorted by latest activity (cursor = ISO ts).
messages.get("/threads", async (c) => {
	const userId = await getAuthenticatedUserId(c);
	if (!userId) return c.json({ error: "Unauthorized" }, 401);

	const cursor = c.req.query("cursor") ?? null;
	const limit = Math.min(
		parseInt(c.req.query("limit") ?? String(LIST_PAGE_SIZE), 10),
		LIST_PAGE_SIZE,
	);

	const db = createDb();

	const threadResult = await db.execute(sql`
		WITH latest AS (
			SELECT
				CASE WHEN sender_id = ${userId} THEN recipient_id ELSE sender_id END AS partner_id,
				content,
				"timestamp",
				ROW_NUMBER() OVER (
					PARTITION BY CASE WHEN sender_id = ${userId} THEN recipient_id ELSE sender_id END
					ORDER BY "timestamp" DESC
				) AS rn
			FROM messages
			WHERE sender_id = ${userId} OR recipient_id = ${userId}
		)
		SELECT
			l.partner_id        AS "otherId",
			l.content           AS "lastMessage",
			l."timestamp"       AS "lastMessageAt",
			u.name              AS "otherName",
			( SELECT url FROM media
			  WHERE user_id = l.partner_id AND sort_order = 0
			  LIMIT 1 )         AS "avatarUrl"
		FROM latest l
		JOIN "user" u ON u.id = l.partner_id
		WHERE l.rn = 1
		${cursor ? sql`AND l."timestamp" < ${cursor}::timestamptz` : sql``}
		ORDER BY l."timestamp" DESC
		LIMIT ${limit}
	`);

	const threads = threadResult.rows.map((r) => {
		const row = r as Record<string, unknown>;
		return {
			id: String(row.otherId),
			otherId: String(row.otherId),
			otherName: String(row.otherName ?? ""),
			avatarUrl: row.avatarUrl ? String(row.avatarUrl) : null,
			lastMessage: String(row.lastMessage ?? ""),
			lastMessageAt: String(row.lastMessageAt ?? ""),
		};
	});

	const nextCursor =
		threads.length > 0
			? (threads[threads.length - 1]?.lastMessageAt ?? null)
			: null;

	return c.json({ threads, nextCursor, limit });
});

// ── GET /:threadId ────────────────────────────────────────────────────────────
// Paginated message history between current user and <threadId> (other user's ID).
// Returns messages oldest-first; cursor = ISO timestamp of the oldest message
// in the current page (pass it to get earlier messages).
messages.get("/:threadId", async (c) => {
	const userId = await getAuthenticatedUserId(c);
	if (!userId) return c.json({ error: "Unauthorized" }, 401);

	const { threadId } = c.req.param();
	const cursor = c.req.query("cursor") ?? null;
	const limit = Math.min(
		parseInt(c.req.query("limit") ?? String(LIST_PAGE_SIZE), 10),
		LIST_PAGE_SIZE,
	);

	const db = createDb();

	const histResult = await db.execute(sql`
		SELECT
			id,
			sender_id    AS "senderId",
			recipient_id AS "recipientId",
			content,
			"timestamp"  AS "sentAt"
		FROM messages
		WHERE (sender_id = ${userId} AND recipient_id = ${threadId})
		   OR (sender_id = ${threadId} AND recipient_id = ${userId})
		${cursor ? sql`AND "timestamp" < ${cursor}::timestamptz` : sql``}
		ORDER BY "timestamp" DESC
		LIMIT ${limit}
	`);

	// Reverse so oldest is first (natural reading order in chat UI).
	const msgs = [...histResult.rows].reverse().map((r) => {
		const row = r as Record<string, unknown>;
		return {
			id: String(row.id),
			senderId: String(row.senderId),
			recipientId: String(row.recipientId),
			content: String(row.content),
			sentAt: String(row.sentAt),
			isRead: false,
		};
	});

	// nextCursor lets the client load earlier messages.
	const nextCursor =
		histResult.rows.length > 0 && histResult.rows.length === limit
			? String((histResult.rows[histResult.rows.length - 1] as Record<string, unknown>).sentAt ?? "")
			: null;

	return c.json({ messages: msgs, nextCursor, limit });
});

// ── POST /:threadId ───────────────────────────────────────────────────────────
// Send a message to <threadId> (= recipientId).
// Gate: FREE users require a mutual match; PREMIUM users can message anyone.
const sendSchema = z.object({ content: z.string().min(1).max(10000) });
const recipientIdSchema = z.string().trim().min(1).max(128);

messages.post("/:threadId", async (c) => {
	const userId = await getAuthenticatedUserId(c);
	if (!userId) return c.json({ error: "Unauthorized" }, 401);

	const parsedRecipient = recipientIdSchema.safeParse(c.req.param("threadId"));
	if (!parsedRecipient.success) {
		return c.json({ error: "Invalid threadId" }, 400);
	}
	const recipientId = parsedRecipient.data;
	if (recipientId === userId) {
		return c.json({ error: "Cannot message yourself" }, 400);
	}

	const body = await c.req.json().catch(() => ({}));
	const parsed = sendSchema.safeParse(body);
	if (!parsed.success) {
		return c.json(
			{ error: "Invalid payload", details: parsed.error.flatten() },
			400,
		);
	}

	const db = createDb();
	await expirePremiumIfNeeded(db, userId);

	// Tier check.
	const profileResult = await db.execute(
		sql`SELECT tier FROM profile WHERE user_id = ${userId}`,
	);
	const tier =
		((profileResult.rows[0] as Record<string, unknown>)?.tier as string) ?? "FREE";

	if (tier !== "PREMIUM") {
		// Canonical ordering: user_1 < user_2 lexicographically.
		const u1 = userId < recipientId ? userId : recipientId;
		const u2 = userId < recipientId ? recipientId : userId;
		const matchResult = await db.execute(
			sql`SELECT 1 FROM matches WHERE user_1 = ${u1} AND user_2 = ${u2} LIMIT 1`,
		);
		if (matchResult.rows.length === 0) {
			return c.json(
				{ error: "A match is required to send messages on the free tier" },
				403,
			);
		}
	}

	const msgId = crypto.randomUUID();
	const now = new Date().toISOString();

	await db.execute(sql`
		INSERT INTO messages (id, sender_id, recipient_id, content, "timestamp")
		VALUES (${msgId}, ${userId}, ${recipientId}, ${parsed.data.content}, now())
	`);

	return c.json({
		ok: true as const,
		message: {
			id: msgId,
			senderId: userId,
			recipientId,
			content: parsed.data.content,
			sentAt: now,
			isRead: false,
		},
	});
});
