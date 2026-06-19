import { Hono, type Context } from "hono";
import { z } from "zod";

import { createDb } from "@JustHookUps/db";
import { sql } from "drizzle-orm";

import { LIST_PAGE_SIZE } from "../constants";
import { buildPhotoPayload, getListThumbWidth } from "../lib/photo-payload";
import { resolveViewerPremium } from "../lib/subscription";

type AuthSession = {
	user?: { id?: string };
	session?: { user?: { id?: string } };
};

async function getSessionUserId(c: Context): Promise<string | null> {
	const origin = new URL(c.req.url).origin;
	try {
		const res = await fetch(`${origin}/api/auth/get-session`, {
			method: "GET",
			headers: {
				cookie: c.req.header("cookie") ?? "",
				authorization: c.req.header("authorization") ?? "",
			},
		});
		if (!res.ok) return null;
		const payload = (await res.json().catch(() => null)) as AuthSession | null;
		const id = payload?.user?.id ?? payload?.session?.user?.id;
		return typeof id === "string" && id.length > 0 ? id : null;
	} catch {
		return null;
	}
}

const discoverRequestSchema = z.object({
	userId: z.string().optional(),
	cursor: z.string().optional(),
	limit: z.number().int().min(1).max(LIST_PAGE_SIZE).optional(),
	latitude: z.number().optional(),
	longitude: z.number().optional(),
	distanceKm: z.number().int().optional(),
	minAge: z.number().int().optional(),
	maxAge: z.number().int().optional(),
});

/** S1 Discover — keyset pagination, exclude prior interactions. */
export const discover = new Hono();

function normalizeGender(value: string) {
	const normalized = value.trim().toLowerCase();
	if (normalized === "man" || normalized === "male") return "male";
	if (normalized === "woman" || normalized === "female") return "female";
	return normalized;
}

function normalizePreference(value: string) {
	const normalized = value.trim().toLowerCase();
	if (normalized === "bisexual") return "bi";
	return normalized;
}

discover.get("/", (c) => {
	return c.json({
		profiles: [],
		nextCursor: null as string | null,
		limit: LIST_PAGE_SIZE,
	});
});

discover.post("/", async (c) => {
	const jsonBody = await c.req.json().catch(() => ({}));
	const parsed = discoverRequestSchema.safeParse(jsonBody);

	if (!parsed.success) {
		return c.json(
			{
				error: "Invalid discover request payload",
				details: parsed.error.flatten(),
			},
			400,
		);
	}

	const { userId: clientUserId, cursor } = parsed.data;
	const limit = parsed.data.limit ?? LIST_PAGE_SIZE;

	const db = createDb();
	const workerOrigin = new URL(c.req.url).origin;
	const thumbW = getListThumbWidth(c);

	// Prefer the server-verified session user ID; fall back to client-supplied userId.
	const sessionUserId = await getSessionUserId(c);
	const userId = sessionUserId ?? clientUserId;

	const viewerPremium = await resolveViewerPremium(db, userId);

	// Fetch current user's profile to determine filtering preferences, country,
	// stored coordinates, and discovery radius.
	let userGender = "";
	let userPreference = "";
	let userCountry = "";
	let storedLat: number | null = null;
	let storedLng: number | null = null;
	let storedRadius = 50;
	if (userId) {
		const userProfile = await db.execute(sql`
			select gender, preference, country, location_lat, location_lng, discovery_radius
			from profile
			where user_id = ${userId}
			limit 1
		`);
		if (userProfile.rows.length > 0) {
			const row = userProfile.rows[0] as Record<string, unknown>;
			userGender = String(row.gender ?? "");
			userPreference = String(row.preference ?? "");
			userCountry = String(row.country ?? "");
			storedLat = row.location_lat != null ? Number(row.location_lat) : null;
			storedLng = row.location_lng != null ? Number(row.location_lng) : null;
			storedRadius = row.discovery_radius != null ? Number(row.discovery_radius) : 50;
		}
	}

	// Real-time coords from request override stored profile coords.
	const actorLat = parsed.data.latitude ?? storedLat;
	const actorLng = parsed.data.longitude ?? storedLng;
	// Request distanceKm override takes priority over stored discovery radius.
	const radiusKm = parsed.data.distanceKm ?? storedRadius;

	/**
	 * Gender/preference filtering logic:
	 * - Straight → opposite gender targets with compatible preferences
	 * - Gay/Lesbian → same-gender targets with compatible preferences
	 * - Bi → all genders with mutually compatible preferences
	 */
	let preferenceSql = sql``;
	if (userId && userGender && userPreference) {
		const normalizedGender = normalizeGender(userGender);
		const normalizedPreference = normalizePreference(userPreference);
		const isStraight = normalizedPreference === "straight";
		const isGay = ["gay", "lesbian"].includes(normalizedPreference);
		const isBi = normalizedPreference === "bi";

		if (isStraight) {
			const oppositeGender =
				normalizedGender === "male" ? "female" : "male";
			preferenceSql = sql`
				and lower(
					case
						when lower(p.gender) in ('man', 'male') then 'male'
						when lower(p.gender) in ('woman', 'female') then 'female'
						else lower(p.gender)
					end
				) = ${oppositeGender}
				and (
					lower(p.preference) = 'straight'
					or lower(p.preference) = 'bi'
					${
						normalizedGender === "male"
							? sql`or lower(p.preference) = 'lesbian'`
							: sql`or lower(p.preference) = 'gay'`
					}
				)
			`;
		} else if (isGay) {
			preferenceSql = sql`
				and lower(
					case
						when lower(p.gender) in ('man', 'male') then 'male'
						when lower(p.gender) in ('woman', 'female') then 'female'
						else lower(p.gender)
					end
				) = ${normalizedGender}
				and (
					lower(p.preference) = 'bi'
					or lower(p.preference) = ${normalizedPreference}
				)
			`;
		} else if (isBi) {
			preferenceSql = sql`
				and (
					(lower(p.gender) in ('man', 'male') and (lower(p.preference) = 'straight' or lower(p.preference) = 'bi' or lower(p.preference) = 'gay'))
					or (lower(p.gender) in ('woman', 'female') and (lower(p.preference) = 'straight' or lower(p.preference) = 'bi' or lower(p.preference) = 'lesbian'))
					or lower(p.preference) = 'bi'
				)
			`;
		}
	}

	// Region isolation: restrict to same country; exclude profiles with no country.
	const countrySql =
		userId && userCountry
			? sql`and p.country = ${userCountry}`
			: sql``;

	/**
	 * Haversine distance formula (result in km):
	 *   6371 * acos(LEAST(1, cos(r(lat1))*cos(r(lat2))*cos(r(lng2)-r(lng1)) + sin(r(lat1))*sin(r(lat2))))
	 *
	 * LEAST(1, ...) guards against floating-point values slightly > 1 which make
	 * acos return NaN. When either party has no coordinates the distance is NULL
	 * and those profiles fall through to the end of the ORDER BY.
	 */
	const hasCoords = actorLat !== null && actorLng !== null;

	const distanceExpr = hasCoords
		? sql`
			(6371.0 * acos(LEAST(1.0,
				cos(radians(${actorLat})) * cos(radians(p.location_lat))
				* cos(radians(p.location_lng) - radians(${actorLng}))
				+ sin(radians(${actorLat})) * sin(radians(p.location_lat))
			)))
		`
		: sql`null::double precision`;

	// When we have coords, filter out profiles beyond the discovery radius.
	// Profiles without stored coordinates (location_lat IS NULL) are included
	// regardless so they aren't completely invisible.
	const distanceFilterSql =
		hasCoords
			? sql`and (p.location_lat is null or p.location_lng is null or (6371.0 * acos(LEAST(1.0,
					cos(radians(${actorLat})) * cos(radians(p.location_lat))
					* cos(radians(p.location_lng) - radians(${actorLng}))
					+ sin(radians(${actorLat})) * sin(radians(p.location_lat))
				))) <= ${radiusKm})`
			: sql``;

	const rows = await db.execute(sql`
		select
			u.id,
			u.email,
			u.name,
			coalesce(p.gender, '') as gender,
			coalesce(p.preference, '') as "sexualOrientation",
			coalesce(p.location_lat, 0) as latitude,
			coalesce(p.location_lng, 0) as longitude,
			coalesce(p.country, '') as country,
			p.bio,
			case when p.tier = 'FREE' then false else true end as "isPremium",
			u.created_at as "createdAt",
			u.updated_at as "updatedAt",
			${distanceExpr} as "distanceKm",
			coalesce(
				(
					select json_agg(m.url order by m.sort_order)
					from media m
					where m.user_id = u.id
				),
				'[]'::json
			) as "photoUrls"
		from "user" u
		inner join profile p on p.user_id = u.id
		where p.is_active = true
			${userId ? sql`and u.id <> ${userId}` : sql``}
			${cursor ? sql`and u.id > ${cursor}` : sql``}
			${preferenceSql}
			${countrySql}
			${distanceFilterSql}
			${
				userId
					? sql`and not exists (
							select 1
							from interactions i
							where i.actor_id = ${userId}
								and i.target_id = u.id
						)`
					: sql``
			}
		order by ${hasCoords ? sql`coalesce(${distanceExpr}, 99999) asc,` : sql``} u.id asc
		limit ${limit}
	`);

	const profiles = rows.rows.map((row) => {
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
			country: String((row as Record<string, unknown>).country ?? ""),
			distanceKm:
				(row as Record<string, unknown>).distanceKm != null
					? Math.round(Number((row as Record<string, unknown>).distanceKm) * 10) / 10
					: null,
			photoUrls,
			...(photoThumbUrls ? { photoThumbUrls } : {}),
			bio:
				(row as Record<string, unknown>).bio == null
					? null
					: String((row as Record<string, unknown>).bio),
			isPremium: Boolean((row as Record<string, unknown>).isPremium),
			createdAt: String((row as Record<string, unknown>).createdAt ?? ""),
			updatedAt: String((row as Record<string, unknown>).updatedAt ?? ""),
		};
	});

	const nextCursor =
		profiles.length > 0 ? profiles[profiles.length - 1]?.id ?? null : null;

	return c.json({
		profiles,
		nextCursor,
		limit,
	});
});
