// settings/rbac page — the `applyAllMutation` batch path. The page stages edits
// client-side, then groups every staged delta BY PRINCIPAL and issues ONE PUT to
// /api/rbac/assignments/apply per principal. This pins that contract: a role SWAP
// on user A (revoke the old grant + add a new one) plus an unrelated grant on user
// B must produce exactly TWO PUTs — A carrying { grants:[new], revokes:[oldId] }
// and B carrying { grants:[new], revokes:[] } — never a PUT per delta.

import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { RoleAssignment } from "@/lib/rbac";

// framer-motion ships ESM that ts-jest does not transform — swap it for plain DOM
// elements so the modal and rows render (same shim the other UI tests use).
jest.mock("framer-motion", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factory cannot reference the out-of-scope React import
  const ReactLib = require("react");
  return {
    AnimatePresence: ({ children }: { children: React.ReactNode }) =>
      ReactLib.createElement(ReactLib.Fragment, null, children),
    motion: new Proxy(
      {},
      {
        get:
          (_target: unknown, tag: string) =>
          ({ children, className, onClick, style }: {
            children?: React.ReactNode;
            className?: string;
            onClick?: () => void;
            style?: React.CSSProperties;
          }) =>
            ReactLib.createElement(tag, { className, onClick, style }, children),
      },
    ),
  };
});

// --- Controllable query data --------------------------------------------------
type PageAssignment = RoleAssignment & { username: string; userEmail: string; userName: string };
let ASSIGNMENTS: PageAssignment[] = [];
let USERS: Array<{ username: string; name?: string; email?: string }> = [];

const invalidateQueries = jest.fn().mockResolvedValue(undefined);

// The page calls useQuery three times (assignments / users-config / game servers);
// resolve each by its queryKey head. useMutation drives the REAL mutationFn (which
// calls fetch) synchronously on mutate(), so we exercise the actual batching code.
jest.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: unknown[] }) => {
    const key = queryKey[0];
    if (key === "rbac") return { data: { assignments: ASSIGNMENTS }, isLoading: false };
    if (key === "users-config") return { data: { users: USERS }, isLoading: false };
    if (key === "game-hub") return { data: { servers: [] }, isLoading: false };
    return { data: undefined, isLoading: false };
  },
  useQueryClient: () => ({ invalidateQueries }),
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

import RBACPage from "@/app/(dashboard)/settings/rbac/page";

const fetchMock = jest.fn();

function makeAssignment(over: Partial<PageAssignment> = {}): PageAssignment {
  return {
    id: "a-old",
    roleId: "reader" as RoleAssignment["roleId"],
    scope: "/",
    principalType: "user",
    principalId: "userA",
    grantedBy: "owner",
    grantedAt: "2026-07-01T00:00:00.000Z",
    username: "userA",
    userEmail: "alice@x",
    userName: "Alice",
    ...over,
  };
}

/** Open the Add-assignment modal and stage one grant for `username` with `roleId`. */
function stageGrant(username: string, roleId: string) {
  fireEvent.click(screen.getByRole("button", { name: /add assignment/i }));
  // Modal is the only place with <select>s: [member, role, scope], in DOM order.
  // Re-query fresh before each change — the first change re-renders the modal,
  // which staleness would otherwise drop the second selection.
  fireEvent.change(screen.getAllByRole("combobox")[0], { target: { value: username } });
  fireEvent.change(screen.getAllByRole("combobox")[1], { target: { value: roleId } });
  fireEvent.click(screen.getByRole("button", { name: /stage assignment/i }));
}

/**
 * Open the modal, flip the principal toggle to "group", and stage one grant for
 * an Authentik `groupName` with `roleId`. The group branch swaps the member
 * <select> for a free-text <input>, so the modal's comboboxes are just
 * [role, scope] here (no member picker).
 */
function stageGroupGrant(groupName: string, roleId: string) {
  fireEvent.click(screen.getByRole("button", { name: /add assignment/i }));
  fireEvent.click(screen.getByRole("button", { name: /^group$/i }));
  fireEvent.change(screen.getByPlaceholderText(/platform-operators/i), { target: { value: groupName } });
  fireEvent.change(screen.getAllByRole("combobox")[0], { target: { value: roleId } });
  fireEvent.click(screen.getByRole("button", { name: /stage assignment/i }));
}

/** Parse every apply PUT body, keyed by the principal it targets. */
function applyBodiesByUsername(): Record<string, { username?: string; grants: unknown[]; revokes: unknown[] }> {
  const out: Record<string, { username?: string; grants: unknown[]; revokes: unknown[] }> = {};
  for (const [url, init] of fetchMock.mock.calls as Array<[string, RequestInit]>) {
    expect(url).toBe("/api/rbac/assignments/apply");
    expect(init.method).toBe("PUT");
    const body = JSON.parse(init.body as string);
    out[body.username] = body;
  }
  return out;
}

beforeEach(() => {
  ASSIGNMENTS = [makeAssignment()];
  USERS = [
    { username: "userA", name: "Alice", email: "alice@x" },
    { username: "userB", name: "Bob", email: "bob@x" },
  ];
  invalidateQueries.mockClear();
  fetchMock.mockReset().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
  global.fetch = fetchMock as unknown as typeof fetch;
});

describe("settings/rbac applyAllMutation — one PUT per principal", () => {
  it("stages a swap on A + a grant on B and issues exactly two batched PUTs", async () => {
    render(<RBACPage />);

    // Role swap on A: add a new grant AND mark A's existing assignment for removal.
    stageGrant("userA", "editor");
    fireEvent.click(screen.getByTitle("Mark for removal"));

    // Unrelated grant on B.
    stageGrant("userB", "reader");

    fireEvent.click(screen.getByRole("button", { name: /^Apply/ }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    const bodies = applyBodiesByUsername();
    expect(Object.keys(bodies).sort()).toEqual(["userA", "userB"]);

    // A: the swap — new grant paired with the revoke of the old grant, one PUT.
    expect(bodies.userA.grants).toEqual([{ roleId: "editor", scope: "/" }]);
    expect(bodies.userA.revokes).toEqual(["a-old"]);

    // B: a plain grant, no revokes.
    expect(bodies.userB.grants).toEqual([{ roleId: "reader", scope: "/" }]);
    expect(bodies.userB.revokes).toEqual([]);
  });

  it("does not fan out to a PUT per delta", async () => {
    render(<RBACPage />);

    stageGrant("userA", "editor");
    fireEvent.click(screen.getByTitle("Mark for removal"));
    stageGrant("userB", "reader");

    fireEvent.click(screen.getByRole("button", { name: /^Apply/ }));

    // Three staged deltas (1 grant + 1 revoke on A, 1 grant on B) collapse to two
    // principal-scoped PUTs, not three.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it("sends a group swap as one PUT keyed by { group }, never { username }", async () => {
    // A group principal is addressed by `group`, not `username`. The existing
    // group assignment's principal is its group name, so revoke + regrant on the
    // same group collapse into a single PUT.
    ASSIGNMENTS = [
      makeAssignment({
        id: "g-old",
        principalType: "group",
        principalId: "media-team",
        username: "media-team",
        userName: "media-team",
        userEmail: "",
      }),
    ];
    render(<RBACPage />);

    // Swap the group's role: stage a new group grant and mark the old one for removal.
    stageGroupGrant("media-team", "editor");
    fireEvent.click(screen.getByTitle("Mark for removal"));

    fireEvent.click(screen.getByRole("button", { name: /^Apply/ }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/rbac/assignments/apply");
    expect(init.method).toBe("PUT");
    const body = JSON.parse(init.body as string);

    // Group principals key on `group` and carry NO `username`.
    expect(body.principalType).toBe("group");
    expect(body.group).toBe("media-team");
    expect(body).not.toHaveProperty("username");
    expect(body.grants).toEqual([{ roleId: "editor", scope: "/" }]);
    expect(body.revokes).toEqual(["g-old"]);
  });

  it("shows no effective-access preview until an edit is staged", () => {
    render(<RBACPage />);
    expect(screen.queryByText(/effective access after apply/i)).not.toBeInTheDocument();
  });

  it("renders a live effective-access preview for a freshly staged grant", () => {
    render(<RBACPage />);
    stageGrant("userB", "reader");

    // Panel header + the staged principal appear.
    expect(screen.getByText(/effective access after apply/i)).toBeInTheDocument();
    // "Bob" shows in both the staged assignment row and the preview card.
    expect(screen.getAllByText("Bob").length).toBeGreaterThan(0);
    // Reader confers read across resources — humanized as "View …" lines.
    expect(screen.getByText("View apps")).toBeInTheDocument();
    // A fresh grant is a net gain.
    expect(screen.getByText(/gains access/i)).toBeInTheDocument();
  });

  it("previews a revoke as a net loss that clears the principal's access", () => {
    render(<RBACPage />);
    // userA holds the single seeded reader@/ assignment; mark it for removal.
    fireEvent.click(screen.getByTitle("Mark for removal"));

    expect(screen.getByText(/effective access after apply/i)).toBeInTheDocument();
    expect(screen.getByText(/loses access/i)).toBeInTheDocument();
    expect(screen.getByText(/no effective access remains/i)).toBeInTheDocument();
  });

  it("collapses a swap plus an extra grant on the same user into one PUT", async () => {
    render(<RBACPage />);

    // Swap A's role (new grant + revoke of the old grant) AND stage a second,
    // unrelated grant on the very same user.
    stageGrant("userA", "editor");
    fireEvent.click(screen.getByTitle("Mark for removal"));
    stageGrant("userA", "reader");

    fireEvent.click(screen.getByRole("button", { name: /^Apply/ }));

    // All three deltas share principal userA, so they ride one PUT.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/rbac/assignments/apply");
    const body = JSON.parse(init.body as string);
    expect(body.principalType).toBe("user");
    expect(body.username).toBe("userA");
    expect(body.grants).toEqual([
      { roleId: "editor", scope: "/" },
      { roleId: "reader", scope: "/" },
    ]);
    expect(body.revokes).toEqual(["a-old"]);
  });
});
