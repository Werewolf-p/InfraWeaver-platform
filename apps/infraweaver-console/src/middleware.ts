export { auth as middleware } from "@/lib/auth";

export const config = {
  matcher: ["/((?!api/auth|api/ping|_next/static|_next/image|favicon.ico|auth/signin).*)"],
};
