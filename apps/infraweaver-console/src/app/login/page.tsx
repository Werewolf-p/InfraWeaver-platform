// /login is a canonical alias that renders the same sign-in UI as /auth/signin
// so that curl health checks expecting /login return 200 rather than a redirect.
export { default } from "@/app/auth/signin/page";
