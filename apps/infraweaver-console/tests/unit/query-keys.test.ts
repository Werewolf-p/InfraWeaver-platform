import { queryKeys } from "@/lib/query-keys";

describe("query key registry", () => {
  it("builds shared cluster query keys", () => {
    expect(queryKeys.cluster.quota()).toEqual(["cluster", "quota"]);
    expect(queryKeys.cluster.cost()).toEqual(["cluster", "cost"]);
    expect(queryKeys.cluster.metrics(30)).toEqual(["cluster", "metrics", 30]);
  });

  it("builds shared profile and settings query keys", () => {
    expect(queryKeys.profile.summary()).toEqual(["profile", "summary"]);
    expect(queryKeys.profile.activity()).toEqual(["profile", "activity"]);
    expect(queryKeys.settings.connection("GitHub")).toEqual(["settings", "connection", "github"]);
  });
});
