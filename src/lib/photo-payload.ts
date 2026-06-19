import type { Context } from "hono";

/** Parse `json_agg` / driver variants into a string URL list. */
export function parsePhotoUrls(raw: unknown): string[] {
	if (Array.isArray(raw)) {
		return raw.map((v) => String(v));
	}
	if (typeof raw === "string") {
		try {
			const parsed = JSON.parse(raw) as unknown;
			return Array.isArray(parsed) ? parsed.map((v) => String(v)) : [];
		} catch {
			return [];
		}
	}
	return [];
}

/**
 * FREE viewers only receive the primary (index 0) URL; other slots are empty so
 * full gallery URLs are not exposed server-side (AGENTS premium gate).
 */
export function redactPhotoUrlsForFreeViewer(
	urls: string[],
	viewerHasPremium: boolean,
): string[] {
	if (viewerHasPremium || urls.length <= 1) {
		return [...urls];
	}
	return urls.map((u, i) => (i === 0 ? u : ""));
}

export function normalizeMediaUrl(
	workerOrigin: string,
	sourceUrl: string,
): string {
	const marker = "/api/media/";
	const markerIndex = sourceUrl.indexOf(marker);
	if (markerIndex === -1) {
		return sourceUrl;
	}

	const suffix = sourceUrl.slice(markerIndex + marker.length);
	return `${workerOrigin}${marker}${suffix}`;
}

/**
 * Optional list thumbnails via Cloudflare Image Resizing (`/cdn-cgi/image/...`).
 * Enable with `MEDIA_LIST_THUMB_WIDTH` (e.g. `200`) on the Worker env.
 */
export function cfListThumbnailUrl(
	workerOrigin: string,
	sourceUrl: string,
	width: number,
): string {
	return `${workerOrigin}/cdn-cgi/image/width=${width},fit=cover,format=auto/${encodeURIComponent(sourceUrl)}`;
}

export function getListThumbWidth(c: Context): number | undefined {
	const raw = (c.env as { MEDIA_LIST_THUMB_WIDTH?: string }).MEDIA_LIST_THUMB_WIDTH;
	if (!raw?.trim()) {
		return undefined;
	}
	const n = Number.parseInt(raw, 10);
	return Number.isFinite(n) && n > 0 && n <= 4096 ? n : undefined;
}

export function buildPhotoPayload(
	workerOrigin: string,
	rawPhotoUrls: unknown,
	viewerHasPremium: boolean,
	thumbWidth: number | undefined,
): { photoUrls: string[]; photoThumbUrls?: string[] } {
	const urls = parsePhotoUrls(rawPhotoUrls).map((url) =>
		normalizeMediaUrl(workerOrigin, url),
	);
	const photoUrls = redactPhotoUrlsForFreeViewer(urls, viewerHasPremium);

	if (!thumbWidth) {
		return { photoUrls };
	}

	const photoThumbUrls = photoUrls.map((u) =>
		u ? cfListThumbnailUrl(workerOrigin, u, thumbWidth) : "",
	);
	return { photoUrls, photoThumbUrls };
}
