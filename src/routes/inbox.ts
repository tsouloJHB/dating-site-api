import { Hono, type Context } from "hono";
import { sql } from "drizzle-orm";

import { createDb } from "@JustHookUps/db";

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

/** S2 — Who liked me, visitors (tier-gated in API responses when implemented). */
export const inbox = new Hono();

inbox.get("/likes-in", async (c) => {
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

		// Get users who liked the current user (where userId is targetId, type is LIKE)
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
			inner join "user" u on i.actor_id = u.id
			inner join profile p on p.user_id = u.id
			where i.target_id = ${userId}
				and i.type = 'LIKE'
				${cursor ? sql`and i.actor_id > ${cursor}` : sql``}
			order by i.actor_id asc
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
		console.error("Likes-in endpoint error:", error);
		return c.json({ error: "Internal server error" }, 500);
	}
});

inbox.get("/visitors", async (c) => {
	const userId = await getAuthenticatedUserId(c);
	if (!userId) {
		return c.json({ error: "Unauthorized" }, 401);
	}

	const cursor = c.req.query("cursor");
	const cursorDate = cursor ? new Date(cursor) : null;
	const hasCursor = Boolean(
		cursorDate && !Number.isNaN(cursorDate.getTime()),
	);
	const limit = Math.min(
		parseInt(c.req.query("limit") ?? String(LIST_PAGE_SIZE)),
		LIST_PAGE_SIZE,
	);

	try {
		const db = createDb();
		const viewerPremium = await resolveViewerPremium(db, userId);
		const workerOrigin = new URL(c.req.url).origin;
		const thumbW = getListThumbWidth(c);

		const totalRows = await db.execute(sql`
			select count(*)::int as total
			from (
				select distinct pv.viewer_id
				from profile_views pv
				where pv.profile_user_id = ${userId}
			) t
		`);
		const totalCount = Number(
			(totalRows.rows[0] as Record<string, unknown> | undefined)?.total ?? 0,
		);

		// Get latest unique viewers for the current user's profile
		const rows = await db.execute(sql`
			with latest_visitors as (
				select pv.viewer_id, max(pv.viewed_at) as viewed_at
				from profile_views pv
				where pv.profile_user_id = ${userId}
				group by pv.viewer_id
			),
			paged as (
				select lv.viewer_id, lv.viewed_at
				from latest_visitors lv
				where ${
					hasCursor
						? sql`lv.viewed_at < ${cursorDate!.toISOString()}::timestamptz`
						: sql`true`
				}
				order by lv.viewed_at desc, lv.viewer_id asc
				limit ${limit}
			)
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
				paged.viewed_at as "viewedAt"
			from paged
			inner join "user" u on paged.viewer_id = u.id
			inner join profile p on p.user_id = u.id
			order by paged.viewed_at desc, paged.viewer_id asc
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
				viewedAt: String((row as Record<string, unknown>).viewedAt ?? ""),
				createdAt: String((row as Record<string, unknown>).createdAt ?? ""),
				updatedAt: String((row as Record<string, unknown>).updatedAt ?? ""),
			};
		});

		const nextCursor =
			users.length > 0 ? users[users.length - 1]?.viewedAt ?? null : null;

		return c.json({
			users,
			nextCursor,
			totalCount,
			limit,
		});
	} catch (error) {
		console.error("Visitors endpoint error:", error);
		return c.json({ error: "Internal server error" }, 500);
	}
});
