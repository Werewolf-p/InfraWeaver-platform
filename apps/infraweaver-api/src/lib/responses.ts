import type { Context } from 'hono';
import type { ZodError } from 'zod';
import type { AppBindings } from '../types/index.js';

/** Context for every route in this app (Hono<AppBindings>). */
type Ctx = Context<AppBindings>;

/** 403 Forbidden. Defaults to the bare `Forbidden` message used by RBAC gates. */
export const forbidden = (c: Ctx, message = 'Forbidden') => c.json({ error: message }, 403);

/** 400 Bad Request with a plain message. */
export const badRequest = (c: Ctx, message: string) => c.json({ error: message }, 400);

/** 400 Bad Request from a failed zod parse (`parsed.error`). */
export const invalidBody = (c: Ctx, error: ZodError) => c.json({ error: error.flatten() }, 400);

/** 404 Not Found. */
export const notFound = (c: Ctx, message: string) => c.json({ error: message }, 404);

/** 502 Bad Gateway — an upstream (Kubernetes, ArgoCD, Traefik, …) call failed. */
export const upstream = (c: Ctx, message: string) => c.json({ error: message }, 502);
