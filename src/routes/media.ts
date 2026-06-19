import { createDb } from "@JustHookUps/db";
import { media as mediaTable } from "@JustHookUps/db/schema/domain";
import { and, eq, inArray, max } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { z } from "zod";

/** S3/S4 — R2 uploads; URLs referenced in `media` / message payloads. */
export const media = new Hono<{ Bindings: Env }>();

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

function extractMediaObjectKey(publicUrl: string): string | null {
	const marker = "/api/media/";
	const i = publicUrl.indexOf(marker);
	if (i === -1) {
		return null;
	}
	return decodeURIComponent(publicUrl.slice(i + marker.length));
}

const reorderSchema = z.object({
	orderedIds: z.array(z.string().uuid()).min(1),
});
const mediaIdSchema = z.string().uuid();

const MAX_UPLOAD_SIZE_BYTES = 25 * 1024 * 1024;

function isAllowedMediaType(type: string): boolean {
	return type.startsWith("image/") || type.startsWith("video/");
}

media.post("/upload", async (c) => {
	const userId = await getAuthenticatedUserId(c);
	if (!userId) {
		return c.json({ error: "Unauthorized" }, 401);
	}

	const body = await c.req.parseBody();
	const input = body.file ?? body.photo ?? body.media;

	if (!(input instanceof File)) {
		return c.json({ error: "Missing file upload" }, 400);
	}

	if (!isAllowedMediaType(input.type)) {
		return c.json({ error: "Only image and video uploads are supported" }, 400);
	}

	if (input.size > MAX_UPLOAD_SIZE_BYTES) {
		return c.json({ error: "File is too large (max 25MB)" }, 413);
	}

	const ext =
		input.name.includes(".")
			? input.name.split(".").pop()?.toLowerCase() ?? "bin"
			: "bin";
	const mediaId = crypto.randomUUID();
	const objectKey = `${userId}/${mediaId}.${ext}`;

	await c.env.MEDIA_BUCKET.put(objectKey, input.stream(), {
		httpMetadata: {
			contentType: input.type || "application/octet-stream",
		},
		customMetadata: {
			uploaderId: userId,
		},
	});

	const origin = new URL(c.req.url).origin;
	const url = `${origin}/api/media/${encodeURIComponent(objectKey)}`;

	const db = createDb();
	const [agg] = await db
		.select({ m: max(mediaTable.sortOrder) })
		.from(mediaTable)
		.where(eq(mediaTable.userId, userId));
	const prevMax = agg?.m;
	const sortOrder =
		(prevMax === null || prevMax === undefined ? -1 : Number(prevMax)) + 1;

	await db.insert(mediaTable).values({
		id: mediaId,
		userId,
		url,
		isVideo: input.type.startsWith("video/"),
		sortOrder,
	});

	return c.json({
		ok: true as const,
		media: {
			id: mediaId,
			url,
			isVideo: input.type.startsWith("video/"),
			sortOrder,
		},
	});
});

/** Set `sort_order` to array index for the given ids (must all belong to the user). */
media.patch("/reorder", async (c) => {
	const userId = await getAuthenticatedUserId(c);
	if (!userId) {
		return c.json({ error: "Unauthorized" }, 401);
	}

	const body = await c.req.json().catch(() => ({}));
	const parsed = reorderSchema.safeParse(body);
	if (!parsed.success) {
		return c.json(
			{ error: "Invalid payload", details: parsed.error.flatten() },
			400,
		);
	}

	const { orderedIds } = parsed.data;
	const db = createDb();
	const rows = await db
		.select({ id: mediaTable.id })
		.from(mediaTable)
		.where(and(eq(mediaTable.userId, userId), inArray(mediaTable.id, orderedIds)));

	if (rows.length !== orderedIds.length) {
		return c.json({ error: "One or more media ids are invalid" }, 400);
	}

	for (let i = 0; i < orderedIds.length; i++) {
		await db
			.update(mediaTable)
			.set({ sortOrder: i })
			.where(
				and(eq(mediaTable.id, orderedIds[i]!), eq(mediaTable.userId, userId)),
			);
	}

	return c.json({ ok: true as const });
});

/** Delete DB row and R2 object for owned media. */
media.delete("/item/:id", async (c) => {
	const userId = await getAuthenticatedUserId(c);
	if (!userId) {
		return c.json({ error: "Unauthorized" }, 401);
	}

	const id = c.req.param("id");
	const parsedId = mediaIdSchema.safeParse(id);
	if (!parsedId.success) {
		return c.json({ error: "Invalid media id" }, 400);
	}
	const mediaId = parsedId.data;
	const db = createDb();
	const row = await db.query.media.findFirst({
		where: and(eq(mediaTable.id, mediaId), eq(mediaTable.userId, userId)),
	});

	if (!row) {
		return c.json({ error: "Not found" }, 404);
	}

	const objectKey = extractMediaObjectKey(row.url);
	if (objectKey) {
		await c.env.MEDIA_BUCKET.delete(objectKey);
	}

	await db.delete(mediaTable).where(eq(mediaTable.id, mediaId));

	return c.json({ ok: true as const });
});

media.get("/:key{.+}", async (c) => {
	const key = c.req.param("key");
	const object = await c.env.MEDIA_BUCKET.get(key);
	if (!object) {
		return c.json({ error: "Media not found" }, 404);
	}

	const headers = new Headers();
	object.writeHttpMetadata(headers);
	headers.set("etag", object.httpEtag);
	return new Response(object.body, { headers });
});
