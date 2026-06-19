import { createAuth } from "@JustHookUps/auth";
import { env } from "@JustHookUps/env/server";
import { assertWorkerEnv } from "@JustHookUps/env/worker-env";
import { type Context, Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";

import { account } from "./routes/account";
import { billing } from "./routes/billing";
import { discover } from "./routes/discover";
import { inbox } from "./routes/inbox";
import { interactions } from "./routes/interactions";
import { matches } from "./routes/matches";
import { media } from "./routes/media";
import { messages } from "./routes/messages";
import { users } from "./routes/users";
import { authRateLimit, expensiveRateLimit } from "./lib/rate-limit";
import { requestIdAndStructuredLog } from "./lib/request-log";

assertWorkerEnv(env);

const app = new Hono();

app.onError((err, c) => {
	if (err instanceof HTTPException) {
		const status = err.status;
		const message = err.message || "Request error";
		if (status === 429) {
			return c.json({ error: "Too many requests" }, 429);
		}
		return c.json({ error: message }, status);
	}
	console.error(err);
	return c.json({ error: "Internal Server Error" }, 500);
});

app.notFound((c) => c.json({ error: "Not found" }, 404));

app.use(requestIdAndStructuredLog);

const corsAllowedOrigins = env.CORS_ORIGIN.split(",")
	.map((s) => s.trim())
	.filter(Boolean);

function isLocalHttpWorker(): boolean {
	return env.BETTER_AUTH_URL.startsWith("http://");
}

function isLoopbackBrowserOrigin(origin: string): boolean {
	try {
		const u = new URL(origin);
		if (u.protocol !== "http:") {
			return false;
		}
		return u.hostname === "localhost" || u.hostname === "127.0.0.1";
	} catch {
		return false;
	}
}

/**
 * Echo the request `Origin` when allowed. Explicit `CORS_ORIGIN` entries always win;
 * in local HTTP dev, any `http://localhost:*` / `http://127.0.0.1:*` tab is allowed so
 * Flutter web’s random port matches without editing `.dev.vars` each run.
 */
function resolveAllowedCorsOrigin(requestOrigin: string | undefined): string | null {
	if (!requestOrigin) {
		return null;
	}
	const inExplicitList =
		corsAllowedOrigins.length === 1
			? corsAllowedOrigins[0] === requestOrigin
			: corsAllowedOrigins.includes(requestOrigin);
	if (inExplicitList) {
		return requestOrigin;
	}
	if (isLocalHttpWorker() && isLoopbackBrowserOrigin(requestOrigin)) {
		return requestOrigin;
	}
	return null;
}

function honoCorsOrigin(origin: string, _c: Context): string | undefined {
	return resolveAllowedCorsOrigin(origin) ?? undefined;
}

/** Better Auth returns a raw `Response`, which replaces Hono's `c.res` and drops CORS headers set before `next()`. */

function withAuthResponseCors(c: Context, res: Response): Response {
	const allow = resolveAllowedCorsOrigin(c.req.header("Origin"));
	if (!allow) {
		return res;
	}
	const headers = new Headers(res.headers);
	headers.set("Access-Control-Allow-Origin", allow);
	headers.set("Access-Control-Allow-Credentials", "true");
	headers.set("Access-Control-Expose-Headers", "set-auth-token");
	const vary = headers.get("Vary");
	if (vary?.includes("Origin")) {
		// keep
	} else if (vary) {
		headers.set("Vary", `${vary}, Origin`);
	} else {
		headers.set("Vary", "Origin");
	}
	return new Response(res.body, {
		status: res.status,
		statusText: res.statusText,
		headers,
	});
}

app.use(
	"/*",
	cors({
		origin: honoCorsOrigin,
		allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
		allowHeaders: ["Content-Type", "Authorization"],
		exposeHeaders: ["set-auth-token"],
		credentials: true,
	}),
);

// Rate-limit auth and high-cost routes to reduce abuse and protect DB/R2.
// `GET /api/auth/get-session` is called internally on almost every authenticated
// request (session probe). Applying the same tight limit as sign-in caused 429s;
// route helpers then treated !ok as missing session → 401 → clients cleared tokens.
app.use("/api/auth/*", async (c, next) => {
	const isGetSession =
		c.req.method === "GET" &&
		new URL(c.req.url).pathname.endsWith("/get-session");
	if (isGetSession) {
		await next();
		return;
	}
	await authRateLimit(c, next);
});
app.use("/api/discover", expensiveRateLimit);
app.use("/api/inbox/*", expensiveRateLimit);
app.use("/api/matches", expensiveRateLimit);
app.use("/api/messages/*", expensiveRateLimit);
app.use("/api/media/upload", expensiveRateLimit);
app.use("/api/billing/*", expensiveRateLimit);

app.on(["POST", "GET"], "/api/auth/*", async (c) => {
	const res = await createAuth().handler(c.req.raw);
	return withAuthResponseCors(c, res);
});

app.get("/", (c) => {
	return c.text("OK");
});

app.route("/api/discover", discover);
app.route("/api/interactions", interactions);
app.route("/api/matches", matches);
app.route("/api/messages", messages);
app.route("/api/inbox", inbox);
app.route("/api/media", media);
app.route("/api/billing", billing);
app.route("/api/account", account);
app.route("/api/users", users);

export default app;
