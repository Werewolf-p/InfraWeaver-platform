import { auth } from "@/lib/auth";
import { hasPermission } from "@/lib/rbac";
import { getRoleAssignmentsForSession } from "@/lib/users-config";
import { notFound, redirect } from "next/navigation";
import { WikiContent } from "@/components/wiki/WikiContent";
import { WikiLayout } from "@/components/wiki/WikiLayout";
import { getAllWikiSearchDocuments, getWikiPage, getWikiSections } from "@/lib/wiki";

export default async function WikiPage({ params }: { params: Promise<{ slug: string[] }> }) {
  const { slug } = await params;
  const page = getWikiPage(slug);
  if (!page) notFound();

  const session = await auth();
  if (!session) {
    redirect(`/login?callbackUrl=${encodeURIComponent(page.href)}`);
  }

  const groups: string[] = (session.user as { groups?: string[] } | undefined)?.groups ?? [];
  const { username, roleAssignments } = await getRoleAssignmentsForSession(session, 60);
  const canEdit = hasPermission(groups, "wiki:edit", roleAssignments, "/wiki", username);

  return (
    <WikiLayout
      title={page.page.title}
      description={page.page.description}
      breadcrumb={[
        { label: "Wiki", href: "/wiki" },
        { label: page.section.title },
        { label: page.page.title },
      ]}
      sections={getWikiSections()}
      toc={page.toc}
      searchDocuments={getAllWikiSearchDocuments()}
      currentHref={page.href}
      currentSectionId={page.section.id}
      editUrl={canEdit ? page.editUrl : undefined}
    >
      <WikiContent content={page.content} />
    </WikiLayout>
  );
}
