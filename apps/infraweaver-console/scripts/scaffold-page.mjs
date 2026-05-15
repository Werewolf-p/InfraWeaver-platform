#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const consoleRoot = path.resolve(scriptDir, "..");
const registryPath = path.join(consoleRoot, "src/lib/page-registry.ts");
const appRoot = path.join(consoleRoot, "src/app/(dashboard)");
const apiRoot = path.join(consoleRoot, "src/app/api");
const typesRoot = path.join(consoleRoot, "src/types");

function toLabel(value) {
  return value
    .split(/[-_/]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");
}

function parseArgs(argv) {
  const [slug, ...rest] = argv;
  if (!slug) {
    throw new Error("Usage: npm run scaffold:page -- <slug> [--group=settings] [--icon=LayoutGrid] [--api] [--type=Resource]");
  }

  const options = {
    slug,
    group: "tools",
    icon: "LayoutGrid",
    withApi: false,
    typeName: "",
    label: toLabel(slug),
    description: `${toLabel(slug)} page`,
  };

  for (const arg of rest) {
    if (arg === "--api") options.withApi = true;
    else if (arg.startsWith("--group=")) options.group = arg.slice("--group=".length);
    else if (arg.startsWith("--icon=")) options.icon = arg.slice("--icon=".length);
    else if (arg.startsWith("--type=")) options.typeName = arg.slice("--type=".length);
    else if (arg.startsWith("--label=")) options.label = arg.slice("--label=".length);
    else if (arg.startsWith("--description=")) options.description = arg.slice("--description=".length);
  }

  return options;
}

function ensureMissing(filePath) {
  if (fs.existsSync(filePath)) {
    throw new Error(`Refusing to overwrite existing file: ${path.relative(consoleRoot, filePath)}`);
  }
}

function updateRegistry({ slug, group, icon, label, description }) {
  const source = fs.readFileSync(registryPath, "utf8");
  const marker = "  // __SCAFFOLD_INSERT__";
  const entry = `  {\n    href: \"/${slug}\",\n    groupId: \"${group}\",\n    label: \"${label}\",\n    iconName: \"${icon}\",\n    description: \"${description}\",\n    pageTitle: \"${label}\",\n    pageDescription: \"${description}\",\n    tags: [\"generated\", \"${group}\"],\n  },\n${marker}`;

  if (!source.includes(marker)) {
    throw new Error("Unable to locate scaffold marker in page-registry.ts");
  }

  fs.writeFileSync(registryPath, source.replace(marker, entry));
}

function createPage({ slug, label, typeName }) {
  const pageDir = path.join(appRoot, slug);
  fs.mkdirSync(pageDir, { recursive: true });

  const typeImport = typeName ? `import type { ${typeName} } from \"@/types\";\n` : "";
  const typeStub = typeName
    ? `const items: ${typeName}[] = [];\n\n`
    : "const items: Array<Record<string, string>> = [];\n\n";

  const emptyTitleLiteral = JSON.stringify(`No ${label.toLowerCase()} yet`);
  const fileContents = `"use client";\n\nimport { EmptyState, PageScaffold } from \"@/components/ui\";\nimport { requirePageConfig } from \"@/lib/page-registry\";\n${typeImport}\nconst page = requirePageConfig(\"/${slug}\");\n\nexport default function ${label.replace(/[^a-zA-Z0-9]/g, "")}Page() {\n  ${typeStub}return (\n    <PageScaffold\n      icon={page.icon}\n      title={page.pageTitle ?? page.label}\n      description={page.pageDescription ?? page.description}\n      isEmpty={items.length === 0}\n      emptyState={{\n        title: ${emptyTitleLiteral},\n        description: \"Start by wiring this page to a query or route.\",\n      }}\n    >\n      <EmptyState\n        title=\"Page scaffolded\"\n        description=\"Replace this state with shared panels, tables, and hooks.\"\n      />\n    </PageScaffold>\n  );\n}\n`;

  const pagePath = path.join(pageDir, "page.tsx");
  ensureMissing(pagePath);
  fs.writeFileSync(pagePath, fileContents);
}

function createApiRoute({ slug }) {
  const routeDir = path.join(apiRoot, slug);
  fs.mkdirSync(routeDir, { recursive: true });
  const routePath = path.join(routeDir, "route.ts");
  ensureMissing(routePath);
  fs.writeFileSync(routePath, `import { apiSuccess } from \"@/lib/route-utils\";\n\nexport async function GET() {\n  return apiSuccess({ items: [] });\n}\n`);
}

function createTypeStub({ typeName }) {
  if (!typeName) return;
  const typePath = path.join(typesRoot, `${typeName.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase()}.ts`);
  ensureMissing(typePath);
  fs.writeFileSync(typePath, `export interface ${typeName} {\n  id: string;\n  name: string;\n}\n`);
}

try {
  const options = parseArgs(process.argv.slice(2));
  createPage(options);
  if (options.withApi) createApiRoute(options);
  createTypeStub(options);
  updateRegistry(options);
  console.log(`Scaffolded /${options.slug} in group ${options.group}.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
