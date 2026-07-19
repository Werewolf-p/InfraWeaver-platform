/**
 * Content panel probe — post/page/draft/comment/revision counts plus a short list
 * of recent posts, read live over `wp-cli`. Counts use WP_SAFE (`--skip-plugins
 * --skip-themes`) so a broken plugin can't sink a core count query; every count is
 * emitted as a `KEY=VALUE` line and guarded, and the recent-post read degrades to
 * an empty list on failure.
 */
import { WP_SAFE, kvLine, parseKv, parseJsonArray, toInt, fieldStr } from "../wp-probe";
import type { PanelProbe, PanelProbeContext } from "./contract";

export interface RecentPost {
  readonly title: string;
  readonly date: string | null;
  readonly status: string;
}

export interface ContentData {
  readonly posts: number;
  readonly pages: number;
  readonly drafts: number;
  readonly comments: number;
  readonly pendingComments: number;
  readonly spamComments: number;
  readonly revisions: number;
  readonly recent: readonly RecentPost[];
}

type RecentRow = {
  post_title?: string;
  post_date?: string;
  post_status?: string;
};

export function parseContent(input: { counts: string; recent: string }): ContentData {
  const kv = parseKv(input.counts);
  const count = (key: string): number => toInt(kv.get(key)) ?? 0;

  const recent: RecentPost[] = parseJsonArray<RecentRow>(input.recent).map((row) => ({
    title: fieldStr(row, "post_title") ?? "(untitled)",
    date: fieldStr(row, "post_date"),
    status: fieldStr(row, "post_status") ?? "publish",
  }));

  return {
    posts: count("POSTS"),
    pages: count("PAGES"),
    drafts: count("DRAFTS"),
    comments: count("COMMENTS"),
    pendingComments: count("PENDING"),
    spamComments: count("SPAM"),
    revisions: count("REVISIONS"),
    recent,
  };
}

async function fetchContent(ctx: PanelProbeContext): Promise<ContentData> {
  // One shell batch of guarded counts — cheaper than seven separate execs.
  const countsCmd = [
    kvLine("POSTS", `${WP_SAFE} post list --post_type=post --post_status=publish --format=count`),
    kvLine("PAGES", `${WP_SAFE} post list --post_type=page --post_status=publish --format=count`),
    kvLine("DRAFTS", `${WP_SAFE} post list --post_type=post --post_status=draft --format=count`),
    kvLine("COMMENTS", `${WP_SAFE} comment list --format=count`),
    kvLine("PENDING", `${WP_SAFE} comment list --status=hold --format=count`),
    kvLine("SPAM", `${WP_SAFE} comment list --status=spam --format=count`),
    kvLine("REVISIONS", `${WP_SAFE} post list --post_type=revision --format=count`),
  ].join("\n");

  const [counts, recent] = await Promise.all([
    ctx.exec(countsCmd).then((r) => r.stdout).catch(() => ""),
    ctx
      .exec(`${WP_SAFE} post list --post_type=post --posts_per_page=8 --fields=post_title,post_date,post_status --format=json`)
      .then((r) => r.stdout)
      .catch(() => "[]"),
  ]);

  return parseContent({ counts, recent });
}

export const contentProbe: PanelProbe<ContentData> = {
  id: "content",
  fetch: fetchContent,
};
