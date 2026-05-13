import fs from "fs";
import path from "path";
import { cache } from "react";

export interface WikiPageMeta {
  slug: string;
  title: string;
  description: string;
  file: string;
  keywords?: string[];
}

export interface WikiSectionMeta {
  id: string;
  title: string;
  description: string;
  pages: WikiPageMeta[];
}

interface WikiIndex {
  sections: WikiSectionMeta[];
}

export interface WikiHeading {
  id: string;
  text: string;
  level: 2 | 3;
}

export interface WikiResolvedPage {
  section: WikiSectionMeta;
  page: WikiPageMeta;
  content: string;
  toc: WikiHeading[];
  href: string;
  githubPath: string;
  editUrl: string;
}

export interface WikiSearchDocument {
  id: string;
  title: string;
  description: string;
  sectionId: string;
  sectionTitle: string;
  href: string;
  content: string;
  keywords: string[];
  githubPath: string;
}

const WIKI_ROOT = path.join(process.cwd(), "src/wiki");
const INDEX_PATH = path.join(WIKI_ROOT, "index.json");

function normalizeHeadingText(value: string) {
  return value
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[`*_~]/g, "")
    .replace(/<[^>]+>/g, "")
    .trim();
}

export function slugifyHeading(text: string) {
  return normalizeHeadingText(text)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function stripMarkdown(markdown: string) {
  return markdown
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```[^\n]*\n?/g, " "))
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^>\s?/gm, "")
    .replace(/^#+\s+/gm, "")
    .replace(/[|*_~]/g, " ")
    .replace(/\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function extractWikiHeadings(markdown: string): WikiHeading[] {
  const headings: WikiHeading[] = [];

  for (const line of markdown.split("\n")) {
    const match = /^(##|###)\s+(.+)$/.exec(line.trim());
    if (!match) continue;

    const level = match[1] === "##" ? 2 : 3;
    const text = normalizeHeadingText(match[2]);
    if (!text) continue;

    headings.push({
      id: slugifyHeading(text),
      text,
      level,
    });
  }

  return headings;
}

const loadWikiIndex = cache(() => {
  const raw = fs.readFileSync(INDEX_PATH, "utf-8");
  return JSON.parse(raw) as WikiIndex;
});

export const getWikiSections = cache(() => loadWikiIndex().sections);

export function getWikiPageHref(sectionId: string, pageSlug: string) {
  return `/wiki/${sectionId}/${pageSlug}`;
}

export function getWikiGitHubPath(relativeFile: string) {
  return `src/wiki/${relativeFile}`;
}

export function getWikiEditUrl(githubPath: string) {
  const repo = process.env.GITHUB_REPO ?? "Werewolf-p/InfraWeaver-platform";
  return `https://github.com/${repo}/edit/main/apps/infraweaver-console/${githubPath}`;
}

function getWikiSourcePath(relativeFile: string) {
  return path.join(WIKI_ROOT, relativeFile);
}

export function getWikiPage(slug: string[]): WikiResolvedPage | null {
  if (slug.length !== 2) return null;

  const [sectionId, pageSlug] = slug;
  const section = getWikiSections().find((entry) => entry.id === sectionId);
  if (!section) return null;

  const page = section.pages.find((entry) => entry.slug === pageSlug);
  if (!page) return null;

  const content = fs.readFileSync(getWikiSourcePath(page.file), "utf-8");
  const githubPath = getWikiGitHubPath(page.file);

  return {
    section,
    page,
    content,
    toc: extractWikiHeadings(content),
    href: getWikiPageHref(section.id, page.slug),
    githubPath,
    editUrl: getWikiEditUrl(githubPath),
  };
}

export const getAllWikiSearchDocuments = cache(() => {
  return getWikiSections().flatMap((section) =>
    section.pages.map((page) => {
      const content = fs.readFileSync(getWikiSourcePath(page.file), "utf-8");
      const githubPath = getWikiGitHubPath(page.file);

      return {
        id: `${section.id}/${page.slug}`,
        title: page.title,
        description: page.description,
        sectionId: section.id,
        sectionTitle: section.title,
        href: getWikiPageHref(section.id, page.slug),
        content: stripMarkdown(content),
        keywords: page.keywords ?? [],
        githubPath,
      } satisfies WikiSearchDocument;
    }),
  );
});
