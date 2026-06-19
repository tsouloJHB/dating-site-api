import { type MiddlewareHandler } from "hono";

type LogRecord = {
  level: "info" | "error";
  requestId: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  userAgent: string | null;
  ip: string | null;
};

function getHeader(req: Request, key: string): string | null {
  const value = req.headers.get(key);
  return value && value.trim().length > 0 ? value : null;
}

function clientIp(req: Request): string | null {
  return (
    getHeader(req, "cf-connecting-ip") ??
    getHeader(req, "x-forwarded-for")?.split(",")[0]?.trim() ??
    null
  );
}

function toJson(record: LogRecord): string {
  return JSON.stringify(record);
}

export const requestIdAndStructuredLog: MiddlewareHandler = async (c, next) => {
  const start = Date.now();
  const requestId = c.req.header("x-request-id") ?? crypto.randomUUID();

  c.set("requestId", requestId);
  c.header("x-request-id", requestId);

  try {
    await next();
  } catch (error) {
    const durationMs = Date.now() - start;
    const req = c.req.raw;
    const record: LogRecord = {
      level: "error",
      requestId,
      method: req.method,
      path: new URL(req.url).pathname,
      status: 500,
      durationMs,
      userAgent: getHeader(req, "user-agent"),
      ip: clientIp(req),
    };
    console.error(toJson(record));
    throw error;
  }

  const durationMs = Date.now() - start;
  const req = c.req.raw;
  const record: LogRecord = {
    level: "info",
    requestId,
    method: req.method,
    path: new URL(req.url).pathname,
    status: c.res.status,
    durationMs,
    userAgent: getHeader(req, "user-agent"),
    ip: clientIp(req),
  };
  console.info(toJson(record));
};
