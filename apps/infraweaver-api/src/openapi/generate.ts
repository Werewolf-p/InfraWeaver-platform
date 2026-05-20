import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOpenApiDocument } from './spec.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '..', '..');
const outputPath = path.join(appRoot, 'openapi.json');

async function main() {
  const serverUrl = process.env.OPENAPI_SERVER_URL ?? 'http://localhost:3001';
  const document = createOpenApiDocument(serverUrl);
  await writeFile(outputPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  console.log(`Wrote OpenAPI spec to ${outputPath}`);
}

main().catch((error) => {
  console.error('[openapi] Failed to generate spec', error);
  process.exit(1);
});
