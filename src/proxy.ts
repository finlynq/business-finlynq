import { NextRequest, NextResponse } from "next/server";

function cookieName(): string {
  return process.env.SESSION_COOKIE_NAME?.trim() ||
    (process.env.NODE_ENV === "production" ? "__Host-business_finlynq_session" : "business_finlynq_session");
}

export function proxy(request: NextRequest) {
  if (request.cookies.has(cookieName())) {
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set("x-business-finlynq-request-path", `${request.nextUrl.pathname}${request.nextUrl.search}`);
    return NextResponse.next({ request: { headers: requestHeaders } });
  }
  const login = request.nextUrl.clone();
  login.pathname = "/login";
  login.search = "";
  login.searchParams.set("next", `${request.nextUrl.pathname}${request.nextUrl.search}`);
  return NextResponse.redirect(login, 307);
}

export const config = { matcher: ["/app/:path*"] };
