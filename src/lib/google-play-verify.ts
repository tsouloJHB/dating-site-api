/**
 * Google Play Developer API — subscription verification.
 *
 * Runs inside a Cloudflare Worker: uses the Web Crypto API (crypto.subtle)
 * for RS256 JWT signing and bare `fetch` for HTTP calls.
 * No Node.js-specific libraries required.
 */

const ANDROID_PUBLISHER_SCOPE =
	"https://www.googleapis.com/auth/androidpublisher";

interface ServiceAccountJson {
	client_email: string;
	private_key: string;
}

// ---------------------------------------------------------------------------
// JWT helpers (base64url, PEM decode, RS256 sign)
// ---------------------------------------------------------------------------

function base64urlEncodeBuffer(buf: ArrayBuffer): string {
	const bytes = new Uint8Array(buf);
	let binary = "";
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function base64urlEncodeString(str: string): string {
	return btoa(unescape(encodeURIComponent(str)))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=/g, "");
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
	const b64 = pem
		.replace(/-----BEGIN PRIVATE KEY-----/, "")
		.replace(/-----END PRIVATE KEY-----/, "")
		.replace(/\s+/g, "");
	const binary = atob(b64);
	const buf = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i);
	return buf.buffer;
}

async function signedJwt(serviceAccount: ServiceAccountJson): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	const header = base64urlEncodeString(JSON.stringify({ alg: "RS256", typ: "JWT" }));
	const payload = base64urlEncodeString(
		JSON.stringify({
			iss: serviceAccount.client_email,
			scope: ANDROID_PUBLISHER_SCOPE,
			aud: "https://oauth2.googleapis.com/token",
			iat: now,
			exp: now + 3600,
		}),
	);

	const signingInput = `${header}.${payload}`;
	const keyData = pemToArrayBuffer(serviceAccount.private_key);
	const cryptoKey = await crypto.subtle.importKey(
		"pkcs8",
		keyData,
		{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign(
		"RSASSA-PKCS1-v1_5",
		cryptoKey,
		new TextEncoder().encode(signingInput),
	);
	return `${signingInput}.${base64urlEncodeBuffer(sig)}`;
}

async function getAccessToken(serviceAccount: ServiceAccountJson): Promise<string> {
	const jwt = await signedJwt(serviceAccount);
	const res = await fetch("https://oauth2.googleapis.com/token", {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
			assertion: jwt,
		}),
	});
	if (!res.ok) {
		const text = await res.text();
		throw new Error(`Google token exchange failed (${res.status}): ${text}`);
	}
	const json = (await res.json()) as { access_token: string };
	return json.access_token;
}

// ---------------------------------------------------------------------------
// SubscriptionPurchaseV2 shape (subset we care about)
// ---------------------------------------------------------------------------

interface LineItem {
	productId: string;
	expiryTime?: string; // RFC 3339
	autoRenewingPlan?: { autoRenewEnabled: boolean };
}

interface SubscriptionPurchaseV2 {
	subscriptionState?: string;
	lineItems?: LineItem[];
	startTime?: string;
	testPurchase?: object;
}

// Subscription states that mean the user has entitlement right now.
const ACTIVE_STATES = new Set([
	"SUBSCRIPTION_STATE_ACTIVE",
	"SUBSCRIPTION_STATE_IN_GRACE_PERIOD",
]);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface PlayVerifyResult {
	/** Whether the subscription currently grants entitlement. */
	isValid: boolean;
	/** When the current billing period ends (null if unknown / invalid). */
	expiresAt: Date | null;
	/** The productId from the first line item. */
	subscriptionId: string | null;
	/** True when this is a sandbox / test purchase. */
	isTestPurchase: boolean;
}

/**
 * Verify a Google Play subscription purchase token against the Android
 * Publisher API.
 *
 * @param packageName   Android application package name (e.g. "com.neonebula.Justhookups")
 * @param purchaseToken Token from the device (PurchaseDetails.verificationData.serverVerificationData)
 * @param serviceAccountJsonStr  Full service-account JSON string (contents of the .json key file)
 */
export async function verifyGooglePlaySubscription(
	packageName: string,
	purchaseToken: string,
	serviceAccountJsonStr: string,
): Promise<PlayVerifyResult> {
	const serviceAccount = JSON.parse(serviceAccountJsonStr) as ServiceAccountJson;
	const accessToken = await getAccessToken(serviceAccount);

	const url =
		`https://androidpublisher.googleapis.com/androidpublisher/v3/applications` +
		`/${encodeURIComponent(packageName)}/purchases/subscriptionsv2/tokens/${encodeURIComponent(purchaseToken)}`;

	const res = await fetch(url, {
		headers: { Authorization: `Bearer ${accessToken}` },
	});

	if (!res.ok) {
		const text = await res.text();
		throw new Error(`Google Play API error (${res.status}): ${text}`);
	}

	const sub = (await res.json()) as SubscriptionPurchaseV2;

	const isValid = ACTIVE_STATES.has(sub.subscriptionState ?? "");
	const isTestPurchase = sub.testPurchase !== undefined;

	// Pick the last expiry from all line items.
	let expiresAt: Date | null = null;
	let subscriptionId: string | null = null;

	for (const item of sub.lineItems ?? []) {
		subscriptionId = item.productId;
		if (item.expiryTime) {
			const d = new Date(item.expiryTime);
			if (!expiresAt || d > expiresAt) expiresAt = d;
		}
	}

	return { isValid, expiresAt, subscriptionId, isTestPurchase };
}
