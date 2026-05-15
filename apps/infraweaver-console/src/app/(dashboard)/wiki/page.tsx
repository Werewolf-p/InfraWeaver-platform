import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowRight, BookOpen, Code2 } from "lucide-react";
import { WikiContent } from "@/components/wiki/WikiContent";
import { WikiLayout } from "@/components/wiki/WikiLayout";
import { auth } from "@/lib/auth";
import { requirePageConfig } from "@/lib/page-registry";
import { extractWikiHeadings, getAllWikiSearchDocuments, getWikiSections } from "@/lib/wiki";

const page = requirePageConfig("/wiki");

const HOME_CONTENT = `
## What lives in the wiki

The Wiki is split into two tracks so operators can jump straight to the right level of detail:

- **User Manual** for day-to-day workflows such as Game Hub, DNS, monitoring, and mobile access
- **Developer Guide** for architecture, API contracts, deployment flow, and maintenance procedures

## Recommended reading path

### New operators

Start with **Getting Started**, then read **Game Hub**, **DNS Management**, and **RBAC & Access Control**.

### Contributors

Start with **Architecture**, then move to **API Reference**, **Deployment**, and **Adding Features**.

## Editing workflow

Wiki content is stored as Markdown in \`src/wiki/\` so it can be reviewed in pull requests, linked to code changes, and versioned alongside the console itself.

> **Note:** Wiki search is client-side. The index is built lazily the first time you type into the search field.
`;

export default async function WikiHomePage() {
  const session = await auth();
  if (!session) {
    redirect("/login?callbackUrl=/wiki");
  }

  const sections = getWikiSections();
  const searchDocuments = getAllWikiSearchDocuments();
  const toc = extractWikiHeadings(HOME_CONTENT);

  return (
    <WikiLayout
      title={page.pageTitle ?? page.label}
      description={page.pageDescription ?? page.description ?? ""}
      breadcrumb={[{ label: "Wiki" }]}
      sections={sections}
      toc={toc}
      searchDocuments={searchDocuments}
      currentHref="/wiki"
    >
      <div className="mb-8 grid gap-4 lg:grid-cols-2">
        {sections.map((section, index) => {
          const Icon = index === 0 ? BookOpen : Code2;
          return (
            <div key={section.id} className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
              <div className="flex items-center gap-3">
                <div className="rounded-xl bg-blue-500/10 p-2 text-blue-200">
                  <Icon className="h-5 w-5" />
                </div>
                <div>
                  <h2 className="text-lg font-semibold text-white">{section.title}</h2>
                  <p className="text-sm text-slate-400">{section.description}</p>
                </div>
              </div>
              <div className="mt-4 space-y-2">
                {section.pages.map((page) => (
                  <Link
                    key={page.slug}
                    href={`/wiki/${section.id}/${page.slug}`}
                    className="flex items-center justify-between rounded-xl border border-white/10 bg-[#0d1117] px-3 py-2.5 text-sm text-slate-200 transition hover:border-blue-500/30 hover:bg-blue-500/10 hover:text-white"
                  >
                    <span>{page.title}</span>
                    <ArrowRight className="h-4 w-4 text-slate-500" />
                  </Link>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      <WikiContent content={HOME_CONTENT} />
    </WikiLayout>
  );
}
