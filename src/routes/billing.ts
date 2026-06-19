import { eq } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { z } from "zod";

import { createDb } from "@JustHookUps/db";
import { profile } from "@JustHookUps/db/schema/domain";

import { expirePremiumIfNeeded } from "../lib/subscription";
import { verifyGooglePlaySubscription } from "../lib/google-play-verify";

/** Google Play purchase token verification → update `profile.tier` (AGENTS §4.2). */
export const billing = new Hono();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AuthSession = {
	user?: { id?: string };
	session?: { user?: { id?: string } };
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getAuthenticatedUserId(c: Context): Promise<string | null> {
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
	const authPayload =
		rawPayload && typeof rawPayload === "object"
			? (rawPayload as AuthSession)
			: null;
	const userId = authPayload?.user?.id ?? authPayload?.session?.user?.id;
	return typeof userId === "string" && userId.length > 0 ? userId : null;
}

function toSubscriptionResponse(
	userId: string,
	isPremium: boolean,
	productId?: string,
	tierExpiresAt: Date | null | undefined = null,
) {
	const endDate =
		isPremium && tierExpiresAt ? tierExpiresAt.toISOString() : (null as string | null);
	return {
		id: `sub-${userId}`,
		userId,
		tier: isPremium ? ("gold" as const) : ("free" as const),
		startDate: new Date().toISOString(),
		endDate,
		isActive: isPremium,
		googlePlaySubscriptionId: isPremium ? (productId ?? "dev-gold") : null,
	};
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const verifySchema = z.object({
	purchaseToken: z.string().min(1),
	productId: z.string().min(1).optional(),
	/** "android" triggers server-side Google Play verification; "dev" skips it. */
	platform: z.enum(["android", "ios", "dev"]).optional(),
	/** ISO-8601 end time (optional; for staging / explicit Play expiry). */
	expiresAt: z.string().min(1).optional(),
	/** Days until expiry when `expiresAt` is omitted (default 30 for dev). */
	expiresInDays: z.number().int().min(1).max(3650).optional(),
});

// ---------------------------------------------------------------------------
// GET /subscriptions — current subscription status
// ---------------------------------------------------------------------------

billing.get("/subscriptions", async (c) => {
	const userId = await getAuthenticatedUserId(c);
	if (!userId) return c.json({ error: "Unauthorized" }, 401);

	const db = createDb();
	await db.insert(profile).values({ userId }).onConflictDoNothing();
	await expirePremiumIfNeeded(db, userId);

	const profileRow = await db.query.profile.findFirst({
		where: eq(profile.userId, userId),
	});
	const isPremium = profileRow?.tier === "PREMIUM";

	return c.json({
		subscription: toSubscriptionResponse(
			userId,
			isPremium,
			undefined,
			profileRow?.tierExpiresAt ?? null,
		),
	});
});

// ---------------------------------------------------------------------------
// POST /verify  (also POST /subscriptions)
// ---------------------------------------------------------------------------

async function postVerifyHandler(c: Context) {
	const userId = await getAuthenticatedUserId(c);
	if (!userId) return c.json({ error: "Unauthorized" }, 401);

	const body = await c.req.json().catch(() => ({}));
	const parsed = verifySchema.safeParse(body);
	if (!parsed.success) {
		return c.json(
			{ error: "Invalid billing payload", details: parsed.error.flatten() },
			400,
		);
	}

	const { purchaseToken, productId, platform } = parsed.data;
	let expiresAt: Date;

	// -------------------------------------------------------------------
	// Android: verify token with Google Play Developer API
	// -------------------------------------------------------------------
	if (platform === "android") {
		const serviceAccountJson = (c.env as Record<string, string>)
			.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON;
		const packageName =
			(c.env as Record<string, string>).GOOGLE_PLAY_PACKAGE_NAME ||
			"com.neonebula.Justhookups";

		if (!serviceAccountJson) {
			return c.json(
				{
					error:
						"Google Play verification is not configured on this server. " +
						"Set GOOGLE_PLAY_SERVICE_ACCOUNT_JSON in Worker secrets.",
				},
				503,
			);
		}

		let result;
		try {
			result = await verifyGooglePlaySubscription(
				packageName,
				purchaseToken,
				serviceAccountJson,
			);
		} catch (err) {
			console.error("[billing] Google Play verify error:", err);
			return c.json({ error: "Could not verify purchase with Google Play." }, 502);
		}

		if (!result.isValid) {
			return c.json({ error: "Purchase token is not active or has expired." }, 402);
		}

		expiresAt =
			result.expiresAt ??
			new Date(Date.now() + 30 * 86_400_000); // fallback: 30 days

	} else {
		// -------------------------------------------------------------------
		// Dev / staging: trust the supplied expiresAt / expiresInDays
		// -------------------------------------------------------------------
		if (parsed.data.expiresAt) {
			expiresAt = new Date(parsed.data.expiresAt);
			if (Number.isNaN(expiresAt.getTime())) {
				return c.json({ error: "Invalid expiresAt" }, 400);
			}
		} else {
			const days = parsed.data.expiresInDays ?? 30;
			expiresAt = new Date(Date.now() + days * 86_400_000);
		}
	}

	const db = createDb();
	await db.insert(profile).values({ userId }).onConflictDoNothing();
	await db
		.update(profile)
		.set({
			tier: "PREMIUM",
			tierExpiresAt: expiresAt,
			// Store the token so the RTDN webhook can look up this user later.
			googlePlayPurchaseToken: platform === "android" ? purchaseToken : null,
		})
		.where(eq(profile.userId, userId));

	return c.json({
		ok: true as const,
		subscription: toSubscriptionResponse(userId, true, productId, expiresAt),
	});
}

billing.post("/subscriptions", postVerifyHandler);
billing.post("/verify", postVerifyHandler);

// ---------------------------------------------------------------------------
// DELETE /subscriptions — cancel (downgrade to FREE)
// ---------------------------------------------------------------------------

billing.delete("/subscriptions", async (c) => {
	const userId = await getAuthenticatedUserId(c);
	if (!userId) return c.json({ error: "Unauthorized" }, 401);

	const db = createDb();
	await db.insert(profile).values({ userId }).onConflictDoNothing();
	await db
		.update(profile)
		.set({ tier: "FREE", tierExpiresAt: null, googlePlayPurchaseToken: null })
		.where(eq(profile.userId, userId));

	return c.json({
		ok: true as const,
		subscription: toSubscriptionResponse(userId, false),
	});
});

// ---------------------------------------------------------------------------
// POST /google-play/webhook — Real-Time Developer Notifications (RTDN)
//
// Set up a Cloud Pub/Sub push subscription pointing at:
//   https://<your-worker>/api/billing/google-play/webhook?secret=<GOOGLE_PLAY_WEBHOOK_SECRET>
// ---------------------------------------------------------------------------

/** Notification types that mean the subscription is currently active. */
const ACTIVE_NOTIFICATION_TYPES = new Set([
	1,  // SUBSCRIPTION_RECOVERED
	2,  // SUBSCRIPTION_RENEWED
	4,  // SUBSCRIPTION_PURCHASED
	6,  // SUBSCRIPTION_IN_GRACE_PERIOD
	7,  // SUBSCRIPTION_RESTARTED
	10, // SUBSCRIPTION_PRICE_CHANGE_CONFIRMED
	12, // SUBSCRIPTION_DEFERRED
	20, // SUBSCRIPTION_PAUSE_SCHEDULE_CHANGED
]);

/** Notification types that mean the subscription has ended / is on hold. */
const INACTIVE_NOTIFICATION_TYPES = new Set([
	3,  // SUBSCRIPTION_CANCELED (note: still active until period end; we only downgrade on 13)
	5,  // SUBSCRIPTION_ON_HOLD (no access)
	13, // SUBSCRIPTION_EXPIRED (no access)
]);

interface SubscriptionNotification {
	version: string;
	notificationType: number;
	purchaseToken: string;
	subscriptionId: string;
}

interface DeveloperNotification {
	version: string;
	packageName: string;
	eventTimeMillis: string;
	subscriptionNotification?: SubscriptionNotification;
}

billing.post("/google-play/webhook", async (c) => {
	// 1. Validate the shared secret to reject unauthenticated callers.
	const webhookSecret = (c.env as Record<string, string>).GOOGLE_PLAY_WEBHOOK_SECRET;
	if (webhookSecret) {
		const suppliedSecret = c.req.query("secret") ?? "";
		if (suppliedSecret !== webhookSecret) {
			return c.json({ error: "Forbidden" }, 403);
		}
	}

	// 2. Decode the Pub/Sub message envelope.
	let notification: DeveloperNotification;
	try {
		const body = await c.req.json() as { message?: { data?: string } };
		const base64Data = body?.message?.data ?? "";
		const jsonStr = atob(base64Data);
		notification = JSON.parse(jsonStr) as DeveloperNotification;
	} catch {
		// Malformed message — ack it anyway so Pub/Sub doesn't retry forever.
		console.warn("[billing/webhook] Could not decode Pub/Sub message");
		return c.json({ ok: true }, 200);
	}

	const sub = notification.subscriptionNotification;
	if (!sub) {
		// Could be a test notification — ack and ignore.
		return c.json({ ok: true }, 200);
	}

	const { purchaseToken, notificationType } = sub;

	// 3. Look up the profile that owns this token.
	const db = createDb();
	const profileRow = await db.query.profile.findFirst({
		where: eq(profile.googlePlayPurchaseToken, purchaseToken),
	});

	if (!profileRow) {
		// Token unknown — either a test purchase or a renewal with a new linked
		// token we haven't seen yet. Log and ack.
		console.info("[billing/webhook] Unknown purchaseToken — skipping", purchaseToken.slice(0, 20));
		return c.json({ ok: true }, 200);
	}

	const userId = profileRow.userId;

	if (INACTIVE_NOTIFICATION_TYPES.has(notificationType)) {
		// Immediately revoke access for on-hold / expired events.
		// For "canceled" (3) we leave the tier active until the period ends;
		// expirePremiumIfNeeded handles that automatically on each GET.
		if (notificationType === 5 || notificationType === 13) {
			await db
				.update(profile)
				.set({ tier: "FREE", tierExpiresAt: null, googlePlayPurchaseToken: null })
				.where(eq(profile.userId, userId));
			console.info(`[billing/webhook] Revoked PREMIUM for user ${userId} (type ${notificationType})`);
		}
	} else if (ACTIVE_NOTIFICATION_TYPES.has(notificationType)) {
		// Re-verify with Play API to get the latest expiry.
		const serviceAccountJson = (c.env as Record<string, string>).GOOGLE_PLAY_SERVICE_ACCOUNT_JSON;
		const packageName =
			(c.env as Record<string, string>).GOOGLE_PLAY_PACKAGE_NAME ||
			"com.neonebula.Justhookups";

		if (serviceAccountJson) {
			try {
				const result = await verifyGooglePlaySubscription(
					packageName,
					purchaseToken,
					serviceAccountJson,
				);
				if (result.isValid) {
					const expiresAt = result.expiresAt ?? new Date(Date.now() + 30 * 86_400_000);
					await db
						.update(profile)
						.set({ tier: "PREMIUM", tierExpiresAt: expiresAt })
						.where(eq(profile.userId, userId));
					console.info(`[billing/webhook] Extended PREMIUM for user ${userId} until ${expiresAt.toISOString()}`);
				}
			} catch (err) {
				console.error("[billing/webhook] Play API error during renewal:", err);
				// Don't revoke on a transient error — expiry will handle it.
			}
		}
	}

	// Always ack — Pub/Sub retries on non-2xx.
	return c.json({ ok: true }, 200);
});
