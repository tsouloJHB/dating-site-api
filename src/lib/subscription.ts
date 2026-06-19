import { createDb } from "@JustHookUps/db";
import { profile } from "@JustHookUps/db/schema/domain";
import { eq } from "drizzle-orm";
import { sql } from "drizzle-orm";

type Db = ReturnType<typeof createDb>;

/** Downgrades PREMIUM → FREE when `tier_expires_at` is in the past. */
export async function expirePremiumIfNeeded(db: Db, userId: string): Promise<void> {
	const result = await db.execute(sql`
		select tier, tier_expires_at
		from profile
		where user_id = ${userId}
		limit 1
	`);
	const row = (result.rows[0] ?? null) as
		| { tier?: string | null; tier_expires_at?: string | Date | null }
		| null;
	if (!row || row.tier !== "PREMIUM" || !row.tier_expires_at) {
		return;
	}
	if (new Date(row.tier_expires_at).getTime() <= Date.now()) {
		await db
			.update(profile)
			.set({ tier: "FREE", tierExpiresAt: null })
			.where(eq(profile.userId, userId));
	}
}

/** Runs expiry refresh then returns whether the viewer currently has premium access. */
export async function resolveViewerPremium(
	db: Db,
	userId: string | null | undefined,
): Promise<boolean> {
	if (!userId) {
		return false;
	}
	await expirePremiumIfNeeded(db, userId);
	const result = await db.execute(sql`
		select tier
		from profile
		where user_id = ${userId}
		limit 1
	`);
	const row = (result.rows[0] ?? null) as { tier?: string | null } | null;
	return row?.tier === "PREMIUM";
}
