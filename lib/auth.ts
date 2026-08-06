import { createHmac, createHash, timingSafeEqual } from "crypto";

/**
 * Session auth primitives. The session cookie carries
 * HMAC-SHA256(SESSION_SECRET, "admin") as hex. Because the payload is constant,
 * a valid cookie simply proves the holder knew the secret at issue time; combined
 * with httpOnly/Secure/SameSite this is sufficient for a single-admin tool.
 *
 * This module is used by both the Edge middleware and Node route handlers, so it
 * relies only on the Web Crypto-compatible `crypto` primitives available in both.
 */

export const SESSION_COOKIE = "bws_session";
export const SESSION_MAX_AGE_SECONDS = 12 * 60 * 60; // 12h

const SESSION_SUBJECT = "admin";

/** The expected cookie value for a given secret. */
export function sessionToken(secret: string): string {
  return createHmac("sha256", secret).update(SESSION_SUBJECT).digest("hex");
}

/** Constant-time comparison of two hex strings of equal expected length. */
function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Verify a presented cookie value against the secret. */
export function verifySessionToken(
  token: string | undefined,
  secret: string,
): boolean {
  if (!token) return false;
  return safeEqualHex(token, sessionToken(secret));
}

/**
 * Compare a submitted password against the admin password using SHA-256 of both
 * sides + timingSafeEqual, so the comparison time does not leak length or prefix.
 */
export function passwordMatches(submitted: string, expected: string): boolean {
  const a = createHash("sha256").update(submitted, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}
