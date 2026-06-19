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

/** S2 — mutual likes list. */
export const matches = new Hono();

matches.get("/", async (c) => {
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

		// Get matches for the current user (either user_1 or user_2 in matches table)
		const rows = await db.execute(sql`
			select
				case 
					when m.user_1 = ${userId} then u.id
					else u2.id
				end as id,
				case 
					when m.user_1 = ${userId} then u.email
					else u2.email
				end as email,
				case 
					when m.user_1 = ${userId} then u.name
					else u2.name
				end as name,
				case 
					when m.user_1 = ${userId} then coalesce(p.gender, '')
					else coalesce(p2.gender, '')
				end as gender,
				case 
					when m.user_1 = ${userId} then coalesce(p.preference, '')
					else coalesce(p2.preference, '')
				end as "sexualOrientation",
				case 
					when m.user_1 = ${userId} then coalesce(p.location_lat, 0)
					else coalesce(p2.location_lat, 0)
				end as latitude,
				case 
					when m.user_1 = ${userId} then coalesce(p.location_lng, 0)
					else coalesce(p2.location_lng, 0)
				end as longitude,
				case 
					when m.user_1 = ${userId} then p.bio
					else p2.bio
				end as bio,
				case 
					when m.user_1 = ${userId} then case when p.tier = 'FREE' then false else true end
					else case when p2.tier = 'FREE' then false else true end
				end as "isPremium",
				case 
					when m.user_1 = ${userId} then u.created_at
					else u2.created_at
				end as "createdAt",
				case 
					when m.user_1 = ${userId} then u.updated_at
					else u2.updated_at
				end as "updatedAt",
				case 
					when m.user_1 = ${userId} then coalesce(
						(
							select json_agg(m2.url order by m2.sort_order)
							from media m2
							where m2.user_id = u.id
						),
						'[]'::json
					)
					else coalesce(
						(
							select json_agg(m2.url order by m2.sort_order)
							from media m2
							where m2.user_id = u2.id
						),
						'[]'::json
					)
				end as "photoUrls",
				m.created_at as "matchedAt"
			from matches m
			inner join "user" u on m.user_2 = u.id
			inner join profile p on p.user_id = u.id
			inner join "user" u2 on m.user_1 = u2.id
			inner join profile p2 on p2.user_id = u2.id
			where (m.user_1 = ${userId} or m.user_2 = ${userId})
				${cursor ? sql`and case when m.user_1 = ${userId} then m.user_2 else m.user_1 end > ${cursor}` : sql``}
			order by case when m.user_1 = ${userId} then m.user_2 else m.user_1 end asc
			limit ${limit}
		`);

		const matchedUsers = rows.rows.map((row) => {
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
				matchedAt: String((row as Record<string, unknown>).matchedAt ?? ""),
				createdAt: String((row as Record<string, unknown>).createdAt ?? ""),
				updatedAt: String((row as Record<string, unknown>).updatedAt ?? ""),
			};
		});

		const nextCursor =
			matchedUsers.length > 0
				? matchedUsers[matchedUsers.length - 1]?.id ?? null
				: null;

		return c.json({
			matches: matchedUsers,
			nextCursor,
			limit,
		});
	} catch (error) {
		console.error("Matches endpoint error:", error);
		return c.json({ error: "Internal server error" }, 500);
	}
});
