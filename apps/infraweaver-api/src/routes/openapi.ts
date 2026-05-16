import { Hono } from 'hono';
import { createOpenApiDocument } from '../openapi/spec.js';

export const openApiRoute = new Hono();

openApiRoute.get('/', (c) => {
  const url = new URL(c.req.url);
  return c.json(createOpenApiDocument(url.origin));
});
