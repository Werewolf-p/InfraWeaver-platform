import { NextResponse } from "next/server";
import { getServerDeployment, makeGameHubClients, withGameHubAuth } from "@/lib/game-hub-server";
import { safeError } from "@/lib/utils";

type DockerHubTagsResponse = {
  results?: Array<{
    name?: string;
    last_updated?: string;
    images?: Array<{ digest?: string }>;
  }>;
};

function parseDockerHubImage(image: string) {
  const withoutDigest = image.split("@")[0] ?? image;
  const parts = withoutDigest.split("/");
  const hasRegistry = parts.length > 1 && (parts[0]?.includes(".") || parts[0] === "localhost");
  const registry = hasRegistry ? parts.shift() ?? "docker.io" : "docker.io";
  if (!["docker.io", "hub.docker.com", "index.docker.io"].includes(registry)) {
    return null;
  }

  const repoWithTag = parts.join("/") || withoutDigest;
  const lastColon = repoWithTag.lastIndexOf(":");
  const lastSlash = repoWithTag.lastIndexOf("/");
  const repo = lastColon > lastSlash ? repoWithTag.slice(0, lastColon) : repoWithTag;
  const currentTag = lastColon > lastSlash ? repoWithTag.slice(lastColon + 1) : "latest";
  const normalizedRepo = repo.includes("/") ? repo : `library/${repo}`;
  return { repo: normalizedRepo, currentTag };
}

export const GET = withGameHubAuth(
  { permission: "game-hub:read", rateLimit: { name: "game-hub-image-check", limit: 5, windowMs: 60_000 } },
  async ({ name }) => {
    try {
      const { appsApi } = makeGameHubClients();
      const deployment = await getServerDeployment(appsApi, name);
      const currentImage = deployment.spec?.template?.spec?.containers?.[0]?.image ?? "";
      const parsedImage = parseDockerHubImage(currentImage);
      if (!parsedImage) {
        return NextResponse.json({ error: "Only Docker Hub images supported" }, { status: 400 });
      }

      const repoPath = parsedImage.repo.split("/").map(encodeURIComponent).join("/");
      const response = await fetch(`https://hub.docker.com/v2/repositories/${repoPath}/tags/?page_size=10&ordering=last_updated`, {
        headers: { "User-Agent": "InfraWeaver Console" },
        next: { revalidate: 300 },
      });
      if (!response.ok) {
        throw new Error(`Docker Hub returned ${response.status}`);
      }

      const data = await response.json() as DockerHubTagsResponse;
      const availableTags = (data.results ?? []).map((tag) => ({
        name: tag.name ?? "",
        lastUpdated: tag.last_updated ?? null,
        digest: tag.images?.[0]?.digest ?? null,
      })).filter((tag) => tag.name);
      const currentIndex = availableTags.findIndex((tag) => tag.name === parsedImage.currentTag);

      return NextResponse.json({
        currentImage,
        currentTag: parsedImage.currentTag,
        availableTags,
        hasNewerTag: currentIndex === -1 ? availableTags.length > 0 : currentIndex > 0,
      });
    } catch (error) {
      console.error("image check route failed", error);
      return NextResponse.json({ error: safeError(error) }, { status: 500 });
    }
  },
);
