/**
 * Renderforge web server (Bun).
 *
 * Serves the bundled frontend and acts as a thin backend-for-frontend:
 * every request the browser makes to /api/* passes through here and is
 * forwarded to the FastAPI backend.
 *
 *   browser ──/api/*──▶ this server ──▶ FastAPI backend ──▶ inference (GPU)
 *
 * Why a proxy instead of calling the backend directly:
 *   - JWTs live in httpOnly cookies, so page scripts can never read them
 *   - access tokens are refreshed here, transparently, on a 401
 *   - no CORS setup, the browser only ever talks to its own origin
 */
import index from "./index.html";

const BACKEND = (process.env.RF_BACKEND_URL ?? "http://localhost:8000").replace(/\/+$/, "");
const PORT = Number(process.env.PORT ?? 3000);
const FORCE_SECURE = process.env.RF_COOKIE_SECURE === "true";
// Backend limit (default 10 MB) plus headroom for multipart overhead.
const MAX_BODY_BYTES = (Number(process.env.RF_MAX_UPLOAD_MB ?? 10) + 2) * 1024 * 1024;

const ACCESS = "rf_access";
const REFRESH = "rf_refresh";
const GENERATION_PATH = /^\/generations(\/[0-9a-fA-F-]{36}(\/download)?)?$/;

interface Tokens {
  access_token: string;
  refresh_token: string;
}

// ---------------------------------------------------------------- cookies

function readCookies(req: Request): Record<string, string> {
  const jar: Record<string, string> = {};
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (!name) continue;
    try {
      jar[name] = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      /* ignore malformed cookie */
    }
  }
  return jar;
}

function isSecure(req: Request): boolean {
  return (
    FORCE_SECURE ||
    new URL(req.url).protocol === "https:" ||
    req.headers.get("x-forwarded-proto") === "https"
  );
}

/** Seconds until a JWT expires, read from its payload. Falls back to 30 minutes. */
function secondsLeft(jwt: string): number {
  try {
    const payload = jwt.split(".")[1] ?? "";
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    const exp = (JSON.parse(json) as { exp?: number }).exp;
    if (typeof exp === "number") return Math.max(60, exp - Math.floor(Date.now() / 1000));
  } catch {
    /* fall through */
  }
  return 1800;
}

function cookie(name: string, value: string, maxAge: number, secure: boolean): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

const tokenCookies = (t: Tokens, secure: boolean): string[] => [
  cookie(ACCESS, t.access_token, secondsLeft(t.access_token), secure),
  cookie(REFRESH, t.refresh_token, secondsLeft(t.refresh_token), secure),
];

const clearCookies = (secure: boolean): string[] => [cookie(ACCESS, "", 0, secure), cookie(REFRESH, "", 0, secure)];

// --------------------------------------------------------------- responses

function withCookies(res: Response, setCookies: string[]): Response {
  for (const c of setCookies) res.headers.append("Set-Cookie", c);
  return res;
}

const jsonResponse = (data: unknown, status = 200, setCookies: string[] = []): Response =>
  withCookies(Response.json(data, { status, headers: { "Cache-Control": "no-store" } }), setCookies);

/** Copy only the headers the browser needs, so nothing internal leaks through. */
function passthrough(upstream: Response, setCookies: string[]): Response {
  const headers = new Headers({ "Cache-Control": "no-store" });
  for (const name of ["content-type", "content-disposition"]) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  const length = upstream.headers.get("content-length");
  if (length && !upstream.headers.get("content-encoding")) headers.set("content-length", length);
  return withCookies(new Response(upstream.body, { status: upstream.status, headers }), setCookies);
}

// ------------------------------------------------------------ backend calls

async function refreshTokens(refreshToken: string): Promise<Tokens | null> {
  const res = await fetch(`${BACKEND}/auth/refresh`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  return res.ok ? ((await res.json()) as Tokens) : null;
}

interface Forward {
  method: string;
  headers?: Record<string, string>;
  body?: ArrayBuffer;
}

/** Calls the backend as the logged-in user, refreshing the access token once if needed. */
async function callAsUser(req: Request, path: string, init: Forward): Promise<{ res: Response; setCookies: string[] }> {
  const secure = isSecure(req);
  const cookies = readCookies(req);
  const refreshToken = cookies[REFRESH];
  let access = cookies[ACCESS];
  let setCookies: string[] = [];
  let refreshTried = false;

  const send = (token?: string) =>
    fetch(`${BACKEND}${path}`, {
      method: init.method,
      headers: { ...init.headers, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: init.body,
    });

  const tryRefresh = async (): Promise<string | null> => {
    refreshTried = true;
    if (!refreshToken) return null;
    const tokens = await refreshTokens(refreshToken);
    if (!tokens) {
      setCookies = clearCookies(secure);
      return null;
    }
    setCookies = tokenCookies(tokens, secure);
    return tokens.access_token;
  };

  if (!access) access = (await tryRefresh()) ?? "";

  let res = await send(access || undefined);
  if (res.status === 401 && !refreshTried) {
    const fresh = await tryRefresh();
    if (fresh) res = await send(fresh);
  }
  return { res, setCookies };
}

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await req.json();
    return body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const text = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

/** Logs in or signs up upstream, stores the tokens in cookies, and returns the user. */
async function startSession(req: Request, upstream: Response, okStatus: number): Promise<Response> {
  if (!upstream.ok) return passthrough(upstream, []);
  const tokens = (await upstream.json()) as Tokens;
  const me = await fetch(`${BACKEND}/auth/me`, { headers: { Authorization: `Bearer ${tokens.access_token}` } });
  if (!me.ok) return jsonResponse({ detail: "Could not load your profile" }, 502);
  return jsonResponse(await me.json(), okStatus, tokenCookies(tokens, isSecure(req)));
}

// ------------------------------------------------------------------ routes

function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true; // same-origin fetches from older browsers, curl, etc.
  try {
    return new URL(origin).host === req.headers.get("host");
  } catch {
    return false;
  }
}

async function handleApi(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api/, "") || "/";
  const method = req.method;

  if (method !== "GET" && method !== "HEAD" && !sameOrigin(req)) {
    return jsonResponse({ detail: "Cross-origin request blocked" }, 403);
  }

  try {
    if (path === "/auth/login" && method === "POST") {
      const body = await readJson(req);
      const email = text(body?.email);
      const password = text(body?.password);
      if (!email || !password) return jsonResponse({ detail: "Email and password are required" }, 400);
      const upstream = await fetch(`${BACKEND}/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ username: email, password }),
      });
      return startSession(req, upstream, 200);
    }

    if (path === "/auth/signup" && method === "POST") {
      const body = await readJson(req);
      const email = text(body?.email);
      const password = text(body?.password);
      if (!email || !password) return jsonResponse({ detail: "Email and password are required" }, 400);
      const upstream = await fetch(`${BACKEND}/auth/signup`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password, full_name: text(body?.full_name) }),
      });
      return startSession(req, upstream, 201);
    }

    if (path === "/auth/logout" && method === "POST") {
      return withCookies(new Response(null, { status: 204 }), clearCookies(isSecure(req)));
    }

    if (path === "/auth/me" && method === "GET") {
      const { res, setCookies } = await callAsUser(req, "/auth/me", { method: "GET" });
      return passthrough(res, setCookies);
    }

    if (GENERATION_PATH.test(path)) {
      const isCollection = path === "/generations";
      if (!(method === "GET" || (method === "POST" && isCollection))) {
        return jsonResponse({ detail: "Method not allowed" }, 405);
      }

      let body: ArrayBuffer | undefined;
      const headers: Record<string, string> = {};
      if (method === "POST") {
        const declared = Number(req.headers.get("content-length") ?? 0);
        if (declared > MAX_BODY_BYTES) return jsonResponse({ detail: "Image is too large" }, 413);
        body = await req.arrayBuffer();
        if (body.byteLength > MAX_BODY_BYTES) return jsonResponse({ detail: "Image is too large" }, 413);
        const type = req.headers.get("content-type");
        if (type) headers["content-type"] = type;
      }

      const { res, setCookies } = await callAsUser(req, `${path}${url.search}`, { method, headers, body });
      return passthrough(res, setCookies);
    }

    return jsonResponse({ detail: "Not found" }, 404);
  } catch (error) {
    console.error(`[proxy] ${method} ${path} failed:`, error);
    return jsonResponse({ detail: "The Renderforge backend is unreachable. Is it running?" }, 502);
  }
}

const server = Bun.serve({
  port: PORT,
  idleTimeout: 120,
  development: process.env.NODE_ENV !== "production",
  routes: {
    "/": index,
    "/healthz": () => Response.json({ ok: true, backend: BACKEND }),
    "/api/*": handleApi,
  },
  fetch: () => new Response("Not found", { status: 404 }),
});

console.log(`Renderforge web  ->  ${server.url}   (backend: ${BACKEND})`);
