import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import { requireAuth } from "@/lib/session";

export const runtime = "nodejs";

export async function POST() {
  const unauth = requireAuth();
  if (unauth) return unauth;

  const res = NextResponse.json({ ok: true });
  res.cookies.set({
    name: SESSION_COOKIE,
    value: "",
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  return res;
}
