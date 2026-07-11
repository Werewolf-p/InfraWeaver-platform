import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { RoleAssignment, RoleDefinition } from "@/lib/rbac";
import type { PlatformUser } from "@/types";

// --- Controllable mock data (tests vary these between renders) ----------------
let ROLES: RoleDefinition[] = [];
let ASSIGNMENTS: RoleAssignment[] = [];

const invalidateQueries = jest.fn().mockResolvedValue(undefined);

// useQuery is called three times (roles / assignments / game servers); resolve
// each by its queryKey head so the panel renders real rows.
jest.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: unknown[] }) => {
    const key = queryKey[0];
    if (key === "security") return { data: { roles: ROLES }, isLoading: false };
    if (key === "users-config") return { data: { role_assignments: ASSIGNMENTS }, isLoading: false };
    if (key === "game-hub") return { data: { servers: [] }, isLoading: false };
    return { data: undefined, isLoading: false };
  },
  useQueryClient: () => ({ invalidateQueries }),
  // Drive the real mutationFn (which calls fetch) synchronously on mutate().
  useMutation: (opts: {
    mutationFn: () => Promise<unknown>;
    onSuccess?: (data: unknown) => void;
    onError?: (err: unknown) => void;
  }) => ({
    isPending: false,
    mutate: () => {
      void (async () => {
        try {
          const data = await opts.mutationFn();
          await opts.onSuccess?.(data);
        } catch (err) {
          opts.onError?.(err);
        }
      })();
    },
  }),
}));

jest.mock("@/lib/notify", () => ({ toast: { success: jest.fn(), error: jest.fn() } }));
jest.mock("@/hooks/use-rbac", () => ({ useRBAC: () => ({ canAny: () => true }) }));

import { RoleAssignmentsPanel } from "@/components/users/role-assignments-panel";

const SCOPE = "/wordpress/sites/blog";
const fetchMock = jest.fn();

function makeRole(id: string, name: string): RoleDefinition {
  return { id: id as RoleDefinition["id"], name, description: "", permissions: [], isBuiltIn: true };
}

function makeAssignment(over: Partial<RoleAssignment> = {}): RoleAssignment {
  return {
    id: "a1",
    roleId: "reader" as RoleAssignment["roleId"],
    scope: SCOPE,
    principalType: "user",
    principalId: "koen",
    grantedBy: "admin",
    grantedAt: "2026-07-01T00:00:00.000Z",
    ...over,
  };
}

const USER = { username: "koen", name: "Koen", email: "k@x", access_level: "user" } as PlatformUser;

function selectNewRole(value: string) {
  fireEvent.change(screen.getByRole("combobox", { name: /new role/i }), { target: { value } });
}

async function lastApplyBody(): Promise<{ username?: string; grants: unknown[]; revokes: unknown[] }> {
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  expect(url).toBe("/api/rbac/assignments/apply");
  expect(init.method).toBe("PUT");
  return JSON.parse(init.body as string);
}

beforeEach(() => {
  ROLES = [makeRole("reader", "Reader"), makeRole("editor", "Editor"), makeRole("admin", "Admin")];
  ASSIGNMENTS = [makeAssignment()];
  invalidateQueries.mockClear();
  fetchMock.mockReset().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
  global.fetch = fetchMock as unknown as typeof fetch;
});

describe("RoleAssignmentsPanel role swap", () => {
  it("offers a change-role control on an existing assignment", () => {
    render(<RoleAssignmentsPanel user={USER} isAdmin />);
    expect(screen.getByRole("button", { name: /change role/i })).toBeInTheDocument();
  });

  it("hides the change-role control from non-admins", () => {
    render(<RoleAssignmentsPanel user={USER} isAdmin={false} />);
    expect(screen.queryByRole("button", { name: /change role/i })).not.toBeInTheDocument();
  });

  it("stages the swap as a paired revoke + grant at the same scope", () => {
    render(<RoleAssignmentsPanel user={USER} isAdmin />);
    fireEvent.click(screen.getByRole("button", { name: /change role/i }));
    selectNewRole("editor");
    fireEvent.click(screen.getByRole("button", { name: /confirm role change/i }));

    // The old grant is marked for removal and the new role staged as an addition.
    expect(screen.getByText(/will remove/i)).toBeInTheDocument();
    expect(screen.getByText(/will add/i)).toBeInTheDocument();
  });

  it("applies the swap in ONE PUT carrying the revoke and the grant together", async () => {
    render(<RoleAssignmentsPanel user={USER} isAdmin />);
    fireEvent.click(screen.getByRole("button", { name: /change role/i }));
    selectNewRole("editor");
    fireEvent.click(screen.getByRole("button", { name: /confirm role change/i }));
    fireEvent.click(screen.getByRole("button", { name: /^Apply/ }));

    const body = await lastApplyBody();
    expect(body.username).toBe("koen");
    expect(body.revokes).toEqual(["a1"]);
    expect(body.grants).toEqual([{ roleId: "editor", scope: SCOPE }]);
  });

  it("carries the original expiry onto the swapped-in grant", async () => {
    ASSIGNMENTS = [makeAssignment({ expiresAt: "2027-01-01T00:00:00.000Z" })];
    render(<RoleAssignmentsPanel user={USER} isAdmin />);
    fireEvent.click(screen.getByRole("button", { name: /change role/i }));
    selectNewRole("admin");
    fireEvent.click(screen.getByRole("button", { name: /confirm role change/i }));
    fireEvent.click(screen.getByRole("button", { name: /^Apply/ }));

    const body = await lastApplyBody();
    expect(body.grants).toEqual([{ roleId: "admin", scope: SCOPE, expiresAt: "2027-01-01T00:00:00.000Z" }]);
  });

  it("stages nothing when the role is left unchanged", () => {
    render(<RoleAssignmentsPanel user={USER} isAdmin />);
    fireEvent.click(screen.getByRole("button", { name: /change role/i }));
    // Leave the select on the current role (Reader) and confirm.
    fireEvent.click(screen.getByRole("button", { name: /confirm role change/i }));
    expect(screen.queryByRole("button", { name: /^Apply/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/will add/i)).not.toBeInTheDocument();
  });

  it("cancels the editor without staging a change", () => {
    render(<RoleAssignmentsPanel user={USER} isAdmin />);
    fireEvent.click(screen.getByRole("button", { name: /change role/i }));
    selectNewRole("editor");
    fireEvent.click(screen.getByRole("button", { name: /cancel role change/i }));
    expect(screen.queryByRole("combobox", { name: /new role/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Apply/ })).not.toBeInTheDocument();
  });
});
