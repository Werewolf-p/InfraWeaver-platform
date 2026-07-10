import { buildAppUserSyncPlan } from "@/lib/app-accounts/plan";
import type { AppUserAccount, DesiredAppUser } from "@/lib/app-accounts/types";

function account(username: string, over: Partial<AppUserAccount> = {}): AppUserAccount {
  return { id: `id-${username}`, username, role: "user", disabled: false, ...over };
}
function want(username: string, role: DesiredAppUser["role"] = "user"): DesiredAppUser {
  return { username, email: `${username}@x.com`, role };
}

const SERVICE = "infraweaver-service";

describe("buildAppUserSyncPlan", () => {
  it("creates a newly-authorized user who has no account yet", () => {
    const plan = buildAppUserSyncPlan({
      desired: [want("alice")],
      existing: [account(SERVICE, { role: "admin" })],
      managed: [],
      protectedUsernames: [SERVICE],
    });
    expect(plan.create).toEqual([{ username: "alice", email: "alice@x.com", role: "user" }]);
    expect(plan.disable).toEqual([]);
  });

  it("does not re-create an already-existing account (idempotency)", () => {
    const plan = buildAppUserSyncPlan({
      desired: [want("alice")],
      existing: [account("alice")],
      managed: ["alice"],
      protectedUsernames: [SERVICE],
    });
    expect(plan.create).toEqual([]);
    expect(plan.setRole).toEqual([]);
    expect(plan.enable).toEqual([]);
    expect(plan.disable).toEqual([]);
  });

  it("disables a managed account that is no longer authorized (revocation)", () => {
    const plan = buildAppUserSyncPlan({
      desired: [],
      existing: [account("alice")],
      managed: ["alice"],
      protectedUsernames: [SERVICE],
    });
    expect(plan.disable).toEqual([{ id: "id-alice", username: "alice" }]);
  });

  it("never disables an account InfraWeaver did not provision (manual/app-native user)", () => {
    const plan = buildAppUserSyncPlan({
      desired: [],
      existing: [account("manual-user")],
      managed: [], // not in the roster
      protectedUsernames: [SERVICE],
    });
    expect(plan.disable).toEqual([]);
  });

  it("never disables or re-creates the service account", () => {
    const plan = buildAppUserSyncPlan({
      desired: [want(SERVICE, "admin")], // even if it somehow appeared authorized
      existing: [account(SERVICE, { role: "admin" })],
      managed: [SERVICE],
      protectedUsernames: [SERVICE],
    });
    expect(plan.create).toEqual([]);
    expect(plan.disable).toEqual([]);
    expect(plan.setRole).toEqual([]);
  });

  it("re-enables a previously-disabled account on a fresh grant", () => {
    const plan = buildAppUserSyncPlan({
      desired: [want("alice")],
      existing: [account("alice", { disabled: true })],
      managed: ["alice"],
      protectedUsernames: [SERVICE],
    });
    expect(plan.enable).toEqual([{ id: "id-alice", username: "alice" }]);
    expect(plan.disable).toEqual([]);
  });

  it("converges the role when the grant changed", () => {
    const plan = buildAppUserSyncPlan({
      desired: [want("alice", "admin")],
      existing: [account("alice", { role: "user" })],
      managed: ["alice"],
      protectedUsernames: [SERVICE],
    });
    expect(plan.setRole).toEqual([{ id: "id-alice", username: "alice", role: "admin" }]);
  });

  it("matches usernames case-insensitively so a case change is not a new account", () => {
    const plan = buildAppUserSyncPlan({
      desired: [want("Alice")],
      existing: [account("alice")],
      managed: ["alice"],
      protectedUsernames: [SERVICE],
    });
    expect(plan.create).toEqual([]);
    expect(plan.disable).toEqual([]);
  });

  it("does not re-disable an already-disabled managed account", () => {
    const plan = buildAppUserSyncPlan({
      desired: [],
      existing: [account("alice", { disabled: true })],
      managed: ["alice"],
      protectedUsernames: [SERVICE],
    });
    expect(plan.disable).toEqual([]);
  });
});
