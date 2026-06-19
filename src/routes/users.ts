import { Hono, type Context } from "hono";
import { z } from "zod";
import { sql } from "drizzle-orm";

import { createDb } from "@JustHookUps/db";

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

/** User endpoints — profile views, public profile detail (S3). */
export const users = new Hono();
const userIdParamSchema = z.string().trim().min(1).max(128);

/**
 * POST /api/users/:userId/views
 * Log that the current user viewed another user's profile.
 */
users.post("/:userId/views", async (c) => {
	const viewerId = await getAuthenticatedUserId(c);
	if (!viewerId) {
		return c.json({ error: "Unauthorized" }, 401);
	}

	const profileUserId = c.req.param("userId");
	const parsedUserId = userIdParamSchema.safeParse(profileUserId);
	if (!parsedUserId.success) {
		return c.json({ error: "Invalid userId" }, 400);
	}
	const targetUserId = parsedUserId.data;

	if (viewerId === targetUserId) {
		// Optionally allow self-views or skip silently
		return c.json({ ok: true }, 200);
	}

	try {
		const db = createDb();

		// Generate UUID v4 using crypto.randomUUID (available in Node.js and Cloudflare Workers)
		const viewId = crypto.randomUUID();

		// Insert a profile view record (viewer_id → profile_user_id)
		await db.execute(sql`
			insert into profile_views (id, viewer_id, profile_user_id, viewed_at)
			values (${viewId}, ${viewerId}, ${targetUserId}, now())
			on conflict do nothing;
		`);

		return c.json({ ok: true as const }, 200);
	} catch (error) {
		console.error("Profile view logging error:", error);
		return c.json({ error: "Internal server error" }, 500);
	}
});

/**
 * GET /api/users/:userId
 * Get public profile of a user (including photo URLs and premium tier info).
 */
users.get("/:userId", async (c) => {
	const userId = c.req.param("userId");

	if (!userId || userId.trim().length === 0) {
		return c.json({ error: "Invalid userId" }, 400);
	}

	try {
		const db = createDb();
		const viewerId = await getAuthenticatedUserId(c);
		const viewerPremium = await resolveViewerPremium(db, viewerId);
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
				p.verification_status as "verificationStatus",
				case when p.tier is null or p.tier = 'FREE' then false else true end as "isPremium",
				u.created_at as "createdAt",
				u.updated_at as "updatedAt",
				coalesce(
					(
						select json_agg(m.url order by m.sort_order)
						from media m
						where m.user_id = u.id
					),
					'[]'::json
				) as "photoUrls"
			from "user" u
			left join profile p on p.user_id = u.id and p.is_active = true
			where u.id = ${userId}
			limit 1
		`);

		if (!rows.rows || rows.rows.length === 0) {
			return c.json({ error: "User not found" }, 404);
		}

		const row = rows.rows[0] as Record<string, unknown>;
		const { photoUrls, photoThumbUrls } = buildPhotoPayload(
			workerOrigin,
			row.photoUrls,
			viewerPremium,
			thumbW,
		);

		let viewerHasLiked = false;
		let hasMatch = false;
		let distanceKm: number | null = null;

		if (viewerId && viewerId !== userId) {
			const rel = await db.execute(sql`
				select
					exists(
						select 1 from interactions
						where actor_id = ${viewerId} and target_id = ${userId} and type = 'LIKE'
					) as "viewerHasLiked",
					exists(
						select 1 from matches
						where (user_1 = ${viewerId} and user_2 = ${userId})
						   or (user_2 = ${viewerId} and user_1 = ${userId})
					) as "hasMatch"
			`);
			const relRow = rel.rows[0] as Record<string, unknown> | undefined;
			if (relRow) {
				viewerHasLiked = Boolean(relRow.viewerHasLiked);
				hasMatch = Boolean(relRow.hasMatch);
			}

			const dist = await db.execute(sql`
				select round(
					(
						6371 * acos(
							least(1::float8, greatest(-1::float8,
								cos(radians(vp.location_lat::float8)) * cos(radians(p.location_lat::float8)) *
								cos(radians(vp.location_lng::float8) - radians(p.location_lng::float8)) +
								sin(radians(vp.location_lat::float8)) * sin(radians(p.location_lat::float8))
							))
						)
					)::numeric,
					1
				)::float8 as "distanceKm"
				from profile p
				inner join profile vp on vp.user_id = ${viewerId}
				where p.user_id = ${userId}
					and p.location_lat is not null and p.location_lng is not null
					and vp.location_lat is not null and vp.location_lng is not null
			`);
			const dRow = dist.rows[0] as Record<string, unknown> | undefined;
			if (dRow?.distanceKm != null && !Number.isNaN(Number(dRow.distanceKm))) {
				distanceKm = Number(dRow.distanceKm);
			}
		}

		return c.json({
			id: String(row.id ?? ""),
			email: String(row.email ?? ""),
			name: String(row.name ?? ""),
			gender: String(row.gender ?? ""),
			sexualOrientation: String(row.sexualOrientation ?? ""),
			age: 18,
			latitude: Number(row.latitude ?? 0),
			longitude: Number(row.longitude ?? 0),
			photoUrls,
			...(photoThumbUrls ? { photoThumbUrls } : {}),
			bio: row.bio == null ? null : String(row.bio),
			verificationStatus: String(row.verificationStatus ?? "UNVERIFIED"),
			isPremium: Boolean(row.isPremium),
			createdAt: String(row.createdAt ?? ""),
			updatedAt: String(row.updatedAt ?? ""),
			viewerHasLiked,
			hasMatch,
			...(distanceKm != null ? { distanceKm } : {}),
		});
	} catch (error) {
		console.error("Get user endpoint error:", error);
		return c.json({ error: "Internal server error" }, 500);
	}
});
