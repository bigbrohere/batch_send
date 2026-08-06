import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "./auth";
import { sessionSecret } from "./env";

/**
 * Defense-in-depth cookie check for Node route handlers. The Edge middleware
 * already guards every route, but each handler re-verifies so a route is never
 * reachable without a valid session even if the matcher changes.
 *
 * Returns null when authorized, or a 401 NextResponse to return otherwise.
 */
export function requireAuth(): NextResponse | null {
  const secret = sessionSecret();
  const token = cookies().get(SESSION_COOKIE)?.value;
  if (secret && verifySessionToken(token, secret)) return null;
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}
