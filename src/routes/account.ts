import { createDb } from "@JustHookUps/db";
import { user } from "@JustHookUps/db/schema/auth";
import { media, profile } from "@JustHookUps/db/schema/domain";
import { count, eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { z } from "zod";

/** S5 — hide (soft) / delete (cascade purge per AGENTS §5). */
export const account = new Hono();

const profileUpdateSchema = z.object({
	bio: z.string().max(2000).optional(),
	gender: z.string().max(64).optional(),
	preferredGender: z.string().max(64).optional(),
	latitude: z.number().min(-90).max(90).optional(),
	longitude: z.number().min(-180).max(180).optional(),
	country: z.string().length(2).toUpperCase().optional(),
	minAgeRange: z.number().int().min(18).max(100).optional(),
	maxAgeRange: z.number().int().min(18).max(100).optional(),
	discoveryRadius: z.number().int().min(1).max(500).optional(),
	interests: z.array(z.string().max(64)).max(50).optional(),
});

const userPatchSchema = z.object({
	name: z.string().min(1).max(128).optional(),
	image: z.union([z.string().url(), z.literal("")]).optional(),
});

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

function normalizeGenderValue(value: string | undefined) {
	if (!value) return value;
	const normalized = value.trim().toLowerCase();
	if (normalized === "man" || normalized === "male") return "male";
	if (normalized === "woman" || normalized === "female") return "female";
	return value.trim();
}

function normalizePreferenceValue(value: string | undefined) {
	if (!value) return value;
	const normalized = value.trim().toLowerCase();
	if (normalized === "bisexual") return "bi";
	return value.trim();
}

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

async function readProfileRow(db: ReturnType<typeof createDb>, userId: string) {
	const result = await db.execute(sql`
		select
			bio,
			gender,
			preference,
			location_lat,
			location_lng,
			country,
			min_age_range,
			max_age_range,
			discovery_radius,
			verification_status,
			verification_requested_at,
			verification_reviewed_at,
			verification_reason
		from profile
		where user_id = ${userId}
		limit 1
	`);

	return (result.rows[0] ?? null) as
		| {
				bio?: string | null;
				gender?: string | null;
				preference?: string | null;
				location_lat?: number | null;
				location_lng?: number | null;
				country?: string | null;
				min_age_range?: number | null;
				max_age_range?: number | null;
				discovery_radius?: number | null;
				verification_status?:
					| "UNVERIFIED"
					| "PENDING"
					| "VERIFIED"
					| "REJECTED"
					| null;
				verification_requested_at?: Date | string | null;
				verification_reviewed_at?: Date | string | null;
				verification_reason?: string | null;
		  }
		| null;
}

function toProfileResponse(params: {
	userId: string;
	bio: string | null;
	gender?: string | null;
	preferredGender: string | null;
	latitude?: number | null;
	longitude?: number | null;
	country?: string | null;
	minAgeRange?: number;
	maxAgeRange?: number;
	discoveryRadius?: number;
	interests?: string[];
	verificationStatus?: "UNVERIFIED" | "PENDING" | "VERIFIED" | "REJECTED";
	verificationRequestedAt?: Date | string | null;
	verificationReviewedAt?: Date | string | null;
	verificationReason?: string | null;
}) {
	return {
		id: params.userId,
		userId: params.userId,
		bio: params.bio ?? "",
		gender: params.gender ?? "",
		latitude: params.latitude ?? 0,
		longitude: params.longitude ?? 0,
		country: params.country ?? "",
		minAgeRange: params.minAgeRange ?? 18,
		maxAgeRange: params.maxAgeRange ?? 99,
		discoveryRadius: params.discoveryRadius ?? 50,
		preferredGender: params.preferredGender ?? "",
		interests: params.interests ?? [],
		verificationStatus: params.verificationStatus ?? "UNVERIFIED",
		verificationRequestedAt: params.verificationRequestedAt,
		verificationReviewedAt: params.verificationReviewedAt,
		verificationReason: params.verificationReason,
	};
}

account.get("/profile", async (c) => {
	const userId = await getAuthenticatedUserId(c);
	if (!userId) {
		return c.json({ error: "Unauthorized" }, 401);
	}

	const db = createDb();

	await db.insert(profile).values({ userId }).onConflictDoNothing();

	const profileRow = await readProfileRow(db, userId);

	return c.json(
		toProfileResponse({
			userId,
			bio: profileRow?.bio ?? null,
			gender: profileRow?.gender ?? null,
			preferredGender: profileRow?.preference ?? null,
			latitude: profileRow?.location_lat ?? null,
			longitude: profileRow?.location_lng ?? null,
			country: profileRow?.country ?? null,
			minAgeRange: profileRow?.min_age_range ?? undefined,
			maxAgeRange: profileRow?.max_age_range ?? undefined,
			discoveryRadius: profileRow?.discovery_radius ?? undefined,
			interests: [],
			verificationStatus: profileRow?.verification_status ?? "UNVERIFIED",
			verificationRequestedAt: profileRow?.verification_requested_at ?? null,
			verificationReviewedAt: profileRow?.verification_reviewed_at ?? null,
			verificationReason: profileRow?.verification_reason ?? null,
		}),
	);
});

async function upsertProfile(c: Context) {
	const userId = await getAuthenticatedUserId(c);
	if (!userId) {
		return c.json({ error: "Unauthorized" }, 401);
	}

	const body = await c.req.json().catch(() => ({}));
	const parsed = profileUpdateSchema.safeParse(body);
	if (!parsed.success) {
		return c.json(
			{ error: "Invalid profile payload", details: parsed.error.flatten() },
			400,
		);
	}

	const db = createDb();

	const cfCountry = c.req.header("cf-ipcountry");
	const resolvedCountry =
		parsed.data.country ??
		(cfCountry && cfCountry !== "XX" && cfCountry !== "T1"
			? cfCountry.toUpperCase()
			: undefined);
	const normalizedGender = normalizeGenderValue(parsed.data.gender);
	const normalizedPreference = normalizePreferenceValue(
		parsed.data.preferredGender,
	);

	const patchValues = {
		...(parsed.data.bio !== undefined ? { bio: parsed.data.bio } : {}),
		...(normalizedGender !== undefined ? { gender: normalizedGender } : {}),
		...(normalizedPreference !== undefined
			? { preference: normalizedPreference }
			: {}),
		...(parsed.data.latitude !== undefined
			? { locationLat: parsed.data.latitude }
			: {}),
		...(parsed.data.longitude !== undefined
			? { locationLng: parsed.data.longitude }
			: {}),
		...(resolvedCountry !== undefined ? { country: resolvedCountry } : {}),
		...(parsed.data.discoveryRadius !== undefined
			? { discoveryRadius: parsed.data.discoveryRadius }
			: {}),
		...(parsed.data.minAgeRange !== undefined
			? { minAgeRange: parsed.data.minAgeRange }
			: {}),
		...(parsed.data.maxAgeRange !== undefined
			? { maxAgeRange: parsed.data.maxAgeRange }
			: {}),
		...(parsed.data.interests !== undefined
			? { interests: parsed.data.interests }
			: {}),
	};

	await db
		.insert(profile)
		.values({
			userId,
			...patchValues,
		})
		.onConflictDoUpdate({
			target: profile.userId,
			set: patchValues,
		});

	const profileRow = await readProfileRow(db, userId);

	return c.json(
		toProfileResponse({
			userId,
			bio: profileRow?.bio ?? null,
			gender: profileRow?.gender ?? null,
			preferredGender: profileRow?.preference ?? null,
			latitude: profileRow?.location_lat ?? null,
			longitude: profileRow?.location_lng ?? null,
			country: profileRow?.country ?? null,
			minAgeRange: profileRow?.min_age_range ?? undefined,
			maxAgeRange: profileRow?.max_age_range ?? undefined,
			discoveryRadius: profileRow?.discovery_radius ?? undefined,
			interests: parsed.data.interests ?? [],
			verificationStatus: profileRow?.verification_status ?? "UNVERIFIED",
			verificationRequestedAt: profileRow?.verification_requested_at ?? null,
			verificationReviewedAt: profileRow?.verification_reviewed_at ?? null,
			verificationReason: profileRow?.verification_reason ?? null,
		}),
	);
}

account.put("/profile", upsertProfile);
account.patch("/profile", upsertProfile);
account.patch("/settings", upsertProfile);

account.get("/verification/status", async (c) => {
	const userId = await getAuthenticatedUserId(c);
	if (!userId) {
		return c.json({ error: "Unauthorized" }, 401);
	}

	const db = createDb();
	await db.insert(profile).values({ userId }).onConflictDoNothing();
	const profileRow = await readProfileRow(db, userId);

	return c.json({
		status: profileRow?.verification_status ?? "UNVERIFIED",
		requestedAt: profileRow?.verification_requested_at ?? null,
		reviewedAt: profileRow?.verification_reviewed_at ?? null,
		reason: profileRow?.verification_reason ?? null,
	});
});

account.post("/verification/request", async (c) => {
	const userId = await getAuthenticatedUserId(c);
	if (!userId) {
		return c.json({ error: "Unauthorized" }, 401);
	}

	const db = createDb();
	await db.insert(profile).values({ userId }).onConflictDoNothing();

	const profileRow = await readProfileRow(db, userId);
	if (profileRow?.verification_status === "VERIFIED") {
		return c.json({ error: "Profile already verified" }, 409);
	}
	if (profileRow?.verification_status === "PENDING") {
		return c.json({
			ok: true as const,
			status: "PENDING",
			requestedAt: profileRow?.verification_requested_at ?? null,
			reason: "Verification request already submitted",
		});
	}

	await db
		.update(profile)
		.set({
			verificationStatus: "PENDING",
			verificationRequestedAt: new Date(),
			verificationReviewedAt: null,
			verificationReason: null,
		})
		.where(eq(profile.userId, userId));

	return c.json({
		ok: true as const,
		status: "PENDING",
		reason: "Verification request received for manual review",
	});
});

account.patch("/user", async (c) => {
	const userId = await getAuthenticatedUserId(c);
	if (!userId) {
		return c.json({ error: "Unauthorized" }, 401);
	}

	const body = await c.req.json().catch(() => ({}));
	const parsed = userPatchSchema.safeParse(body);
	if (!parsed.success) {
		return c.json(
			{ error: "Invalid user payload", details: parsed.error.flatten() },
			400,
		);
	}

	const db = createDb();
	const set: { name?: string; image?: string | null } = {};
	if (parsed.data.name !== undefined) {
		set.name = parsed.data.name;
	}
	if (parsed.data.image !== undefined) {
		set.image = parsed.data.image === "" ? null : parsed.data.image;
	}
	if (Object.keys(set).length === 0) {
		return c.json({ error: "No fields to update" }, 400);
	}

	await db.update(user).set(set).where(eq(user.id, userId));

	const row = await db.query.user.findFirst({
		where: eq(user.id, userId),
	});

	return c.json({
		id: row?.id,
		name: row?.name,
		email: row?.email,
		image: row?.image,
	});
});

/** Require at least one media row before marking onboarding done (AGENTS: min 1 photo). */
account.post("/onboarding/complete", async (c) => {
	const userId = await getAuthenticatedUserId(c);
	if (!userId) {
		return c.json({ error: "Unauthorized" }, 401);
	}

	const db = createDb();
	const [row] = await db
		.select({ n: count() })
		.from(media)
		.where(eq(media.userId, userId));

	if ((row?.n ?? 0) < 1) {
		return c.json(
			{ error: "Upload at least one profile photo before completing onboarding." },
			400,
		);
	}

	return c.json({ ok: true as const });
});

account.patch("/hide", async (c) => {
	const userId = await getAuthenticatedUserId(c);
	if (!userId) {
		return c.json({ error: "Unauthorized" }, 401);
	}

	const db = createDb();
	await db
		.update(profile)
		.set({ isActive: false })
		.where(eq(profile.userId, userId));

	return c.json({ ok: true as const });
});

account.delete("/", async (c) => {
	const userId = await getAuthenticatedUserId(c);
	if (!userId) {
		return c.json({ error: "Unauthorized" }, 401);
	}

	const db = createDb();
	await db.delete(user).where(eq(user.id, userId));

	return c.json({ ok: true as const });
});
