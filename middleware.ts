import { NextResponse, type NextRequest } from "next/server";

/**
 * Route guard. Runs in the Edge runtime, so it uses Web Crypto (`crypto.subtle`)
 * rather than Node's `crypto` module.
 *
 * Public paths: /login and /api/auth/login. Everything else — pages and APIs —
 * requires a valid session cookie. Pages redirect to /login; APIs get a 401.
 */

const SESSION_COOKIE = "bws_session";
const SESSION_SUBJECT = "admin";

const encoder = new TextEncoder();

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

async function expectedToken(secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(SESSION_SUBJECT),
  );
  return toHex(new Uint8Array(sig));
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function isPublicPath(pathname: string): boolean {
  return pathname === "/login" || pathname === "/api/auth/login";
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const isApi = pathname.startsWith("/api/");

  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  const secret = process.env.SESSION_SECRET?.trim();
  const token = req.cookies.get(SESSION_COOKIE)?.value;

  let ok = false;
  if (secret && token) {
    try {
      ok = timingSafeEqual(token, await expectedToken(secret));
    } catch {
      ok = false;
    }
  }

  if (ok) return NextResponse.next();

  if (isApi) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const loginUrl = req.nextUrl.clone();
  loginUrl.pathname = "/login";
  loginUrl.search = "";
  return NextResponse.redirect(loginUrl);
}

export const config = {
  // Guard everything except Next internals and static assets. Public-path checks
  // above still exempt /login and /api/auth/login.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|robots.txt).*)"],
};
