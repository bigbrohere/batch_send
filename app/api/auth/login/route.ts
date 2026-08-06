import { NextResponse } from "next/server";
import { z } from "zod";
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  passwordMatches,
  sessionToken,
} from "@/lib/auth";
import { adminPassword, sessionSecret } from "@/lib/env";

export const runtime = "nodejs";

const schema = z.object({ password: z.string().min(1).max(512) });

/** Fixed delay so failed logins don't leak timing and can't be brute-forced fast. */
function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function POST(req: Request) {
  const expected = adminPassword();
  const secret = sessionSecret();
  if (!expected || !secret) {
    return NextResponse.json(
      { error: "Server not configured" },
      { status: 500 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    body = null;
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    await delay(500);
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  if (!passwordMatches(parsed.data.password, expected)) {
    await delay(500);
    return NextResponse.json({ error: "Invalid password" }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set({
    name: SESSION_COOKIE,
    value: sessionToken(secret),
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
  return res;
}
