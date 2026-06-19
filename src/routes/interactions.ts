import { Hono, type Context } from "hono";
import { z } from "zod";
import { sql, eq, and } from "drizzle-orm";

import { createDb } from "@JustHookUps/db";
import {
	interactions as interactionsTable,
	matches as matchesTable,
} from "@JustHookUps/db/schema/domain";

import { LIST_PAGE_SIZE } from "../constants";
import { buildPhotoPayload, getListThumbWidth } from "../lib/photo-payload";
import { resolveViewerPremium } from "../lib/subscription";

type AuthSession = {
	user?: {
		id?: string;
	};
	session?: {
		user?: {
			id?: string;
		};
	};
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

	if (!authResponse.ok) {
		return null;
	}

	const rawPayload = await authResponse.json().catch(() => null);
	const authPayload =
		rawPayload && typeof rawPayload === "object"
			? (rawPayload as AuthSession)
			: null;
	const userId = authPayload?.user?.id ?? authPayload?.session?.user?.id;
	return typeof userId === "string" && userId.length > 0 ? userId : null;
}

const interactionRequestSchema = z.object({
	targetId: z.string().min(1),
	type: z.enum(["LIKE", "PASS"]),
});

/** Like / pass actions; reciprocal LIKE creates a match. */
export const interactions = new Hono();

interactions.post("/", async (c) => {
	const userId = await getAuthenticatedUserId(c);
	if (!userId) {
		return c.json({ error: "Unauthorized" }, 401);
	}

	try {
		const jsonBody = await c.req.json().catch(() => ({}));
		const parsed = interactionRequestSchema.safeParse(jsonBody);

		if (!parsed.success) {
			return c.json(
				{
					error: "Invalid interaction request",
					details: parsed.error.flatten(),
				},
				400,
			);
		}

		const { targetId, type } = parsed.data;

		if (userId === targetId) {
			return c.json({ error: "Cannot interact with yourself" }, 400);
		}

		const db = createDb();

		// Upsert the interaction (idempotent)
		await db.execute(sql`
			insert into interactions (actor_id, target_id, type, timestamp)
			values (${userId}, ${targetId}, ${type}, now())
			on conflict (actor_id, target_id)
			do update set type = ${type}, timestamp = now();
		`);

		// If LIKE, check for reciprocal and possibly create match
		let matchCreated = false;
		if (type === "LIKE") {
			const reciprocal = await db.query.interactions.findFirst({
				where: and(
					eq(interactionsTable.actorId, targetId),
					eq(interactionsTable.targetId, userId),
					eq(interactionsTable.type, "LIKE"),
				),
			});

			if (reciprocal) {
				// Create match with canonical ordering (user_1 < user_2 lexicographically)
				const user1 = userId < targetId ? userId : targetId;
				const user2 = userId < targetId ? targetId : userId;

				await db
					.insert(matchesTable)
					.values({
						user1,
						user2,
					})
					.onConflictDoNothing();

				matchCreated = true;
			}
		}

		return c.json(
			{
				ok: true as const,
				interaction: {
					actorId: userId,
					targetId,
					type,
					matchCreated,
				},
			},
			200,
		);
	} catch (error) {
		console.error("Interaction endpoint error:", error);
		return c.json({ error: "Internal server error" }, 500);
	}
});

interactions.get("/mine", async (c) => {
	const userId = await getAuthenticatedUserId(c);
	if (!userId) {
		return c.json({ error: "Unauthorized" }, 401);
	}

	const cursor = c.req.query("cursor");
	const limit = Math.min(
		parseInt(c.req.query("limit") ?? String(LIST_PAGE_SIZE)),
		LIST_PAGE_SIZE,
	);

	const db = createDb();

	const rows = await db.execute(sql`
		select
			actor_id as "actorId",
			target_id as "targetId",
			type,
			timestamp
		from interactions
		where actor_id = ${userId}
			${cursor ? sql`and target_id > ${cursor}` : sql``}
		order by target_id asc
		limit ${limit}
	`);

	const items = (rows.rows as Record<string, unknown>[]).map((row) => ({
		actorId: String(row.actorId ?? ""),
		targetId: String(row.targetId ?? ""),
		type: String(row.type ?? ""),
		timestamp: String(row.timestamp ?? ""),
	}));

	const nextCursor =
		items.length > 0 ? items[items.length - 1]?.targetId ?? null : null;

	return c.json({
		items,
		nextCursor,
		limit,
	});
});

interactions.get("/likes-out", async (c) => {
	const userId = await getAuthenticatedUserId(c);
	if (!userId) {
		return c.json({ error: "Unauthorized" }, 401);
	}

	const cursor = c.req.query("cursor");
	const limit = Math.min(
		parseInt(c.req.query("limit") ?? String(LIST_PAGE_SIZE)),
		LIST_PAGE_SIZE,
	);

	try {
		const db = createDb();
		const viewerPremium = await resolveViewerPremium(db, userId);
		const workerOrigin = new URL(c.req.url).origin;
		const thumbW = getListThumbWidth(c);

		const rows = await db.execute(sql`
			select
				u.id,
				u.email,
				u.name,
				coalesce(p.gender, '') as gender,
				coalesce(p.preference, '') as "sexualOrientation",
				coalesce(p.location_lat, 0) as latitude,
				coalesce(p.location_lng, 0) as longitude,
				p.bio,
				case when p.tier = 'FREE' then false else true end as "isPremium",
				u.created_at as "createdAt",
				u.updated_at as "updatedAt",
				coalesce(
					(
						select json_agg(m.url order by m.sort_order)
						from media m
						where m.user_id = u.id
					),
					'[]'::json
				) as "photoUrls",
				i.timestamp as "likedAt"
			from interactions i
			inner join "user" u on i.target_id = u.id
			inner join profile p on p.user_id = u.id
			where i.actor_id = ${userId}
				and i.type = 'LIKE'
				and p.is_active = true
				${cursor ? sql`and i.target_id > ${cursor}` : sql``}
			order by i.target_id asc
			limit ${limit}
		`);

		const users = rows.rows.map((row) => {
			const { photoUrls, photoThumbUrls } = buildPhotoPayload(
				workerOrigin,
				(row as Record<string, unknown>).photoUrls,
				viewerPremium,
				thumbW,
			);

			return {
				id: String((row as Record<string, unknown>).id ?? ""),
				email: String((row as Record<string, unknown>).email ?? ""),
				name: String((row as Record<string, unknown>).name ?? ""),
				gender: String((row as Record<string, unknown>).gender ?? ""),
				sexualOrientation: String(
					(row as Record<string, unknown>).sexualOrientation ?? "",
				),
				age: 18,
				latitude: Number((row as Record<string, unknown>).latitude ?? 0),
				longitude: Number((row as Record<string, unknown>).longitude ?? 0),
				photoUrls,
				...(photoThumbUrls ? { photoThumbUrls } : {}),
				bio:
					(row as Record<string, unknown>).bio == null
						? null
						: String((row as Record<string, unknown>).bio),
				isPremium: Boolean((row as Record<string, unknown>).isPremium),
				likedAt: String((row as Record<string, unknown>).likedAt ?? ""),
				createdAt: String((row as Record<string, unknown>).createdAt ?? ""),
				updatedAt: String((row as Record<string, unknown>).updatedAt ?? ""),
			};
		});

		const nextCursor =
			users.length > 0 ? users[users.length - 1]?.id ?? null : null;

		return c.json({
			users,
			nextCursor,
			limit,
		});
	} catch (error) {
		console.error("Likes-out endpoint error:", error);
		return c.json({ error: "Internal server error" }, 500);
	}
});
