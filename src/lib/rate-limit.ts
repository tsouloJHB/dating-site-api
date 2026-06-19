import { type Context, type MiddlewareHandler } from "hono";

type RateLimitOptions = {
  windowMs: number;
  max: number;
  bucket: string;
};

type BucketEntry = {
  count: number;
  resetAt: number;
};

const buckets = new Map<string, BucketEntry>();

function nowMs() {
  return Date.now();
}

function getClientIp(c: Context): string {
  const cfIp = c.req.header("cf-connecting-ip");
  if (cfIp && cfIp.trim().length > 0) {
    return cfIp.trim();
  }

  const forwarded = c.req.header("x-forwarded-for");
  if (forwarded && forwarded.trim().length > 0) {
    return forwarded.split(",")[0]?.trim() ?? "unknown";
  }

  return "unknown";
}

function shouldSkipMethod(method: string): boolean {
  return method === "OPTIONS" || method === "HEAD";
}

function toRetryAfterSeconds(resetAtMs: number): number {
  const deltaMs = Math.max(0, resetAtMs - nowMs());
  return Math.max(1, Math.ceil(deltaMs / 1000));
}

function cleanupExpiredEntries() {
  const t = nowMs();
  for (const [key, value] of buckets.entries()) {
    if (value.resetAt <= t) {
      buckets.delete(key);
    }
  }
}

export function rateLimit(options: RateLimitOptions): MiddlewareHandler {
  return async (c, next) => {
    if (shouldSkipMethod(c.req.method)) {
      await next();
      return;
    }

    // Opportunistic cleanup keeps memory bounded for long-running isolates.
    if (Math.random() < 0.01) {
      cleanupExpiredEntries();
    }

    const ip = getClientIp(c);
    const key = `${options.bucket}:${ip}`;
    const t = nowMs();

    const current = buckets.get(key);
    if (!current || current.resetAt <= t) {
      buckets.set(key, {
        count: 1,
        resetAt: t + options.windowMs,
      });
      await next();
      return;
    }

    if (current.count >= options.max) {
      const retryAfter = toRetryAfterSeconds(current.resetAt);
      c.header("Retry-After", String(retryAfter));
      return c.json(
        {
          error: "Too many requests",
          code: "RATE_LIMITED",
          retryAfterSeconds: retryAfter,
        },
        429,
      );
    }

    current.count += 1;
    buckets.set(key, current);
    await next();
  };
}

export const authRateLimit = rateLimit({
  windowMs: 60_000,
  max: 20,
  bucket: "auth",
});

export const expensiveRateLimit = rateLimit({
  windowMs: 60_000,
  max: 60,
  bucket: "expensive",
});
