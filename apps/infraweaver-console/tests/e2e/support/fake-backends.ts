// In-process fakes for the three external systems the Jellyfin account flow talks
// to, multiplexed onto one localhost http.Server so a single `close()` tears the
// whole thing down. Dependency-free (node:http only) and fully deterministic — no
// cluster, no OpenBao, no Jellyfin, no GitHub — so the adopt→reset regression runs
// the REAL adapter chain (client → provider → reconcile → store → access.ts)
// against controllable state.
//
//   Jellyfin admin API   — /System/*, /Users*, /Auth/Keys, /Startup/*
//   OpenBao KV v2        — /v1/<mount>/data/*, /v1/<mount>/metadata/*
//   GitHub contents API  — /repos/:owner/:repo/contents/users.yaml (users.yaml source)
//   Authentik core API   — /api/v3/core/users/?username=|email= (identity resolve)
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";

export interface JellyfinUserRecord {
  Id: string;
  Name: string;
  password: string;
  IsAdministrator: boolean;
  IsDisabled: boolean;
}

/**
 * Minimal Authentik user record served by the fake `/api/v3/core/users/` lookup —
 * shaped per the fields `resolveAuthentikIdentity` reads (`pk`, `username`, `email`,
 * `is_active`). `findUserBy` in `lib/authentik.ts` returns `results[0]`.
 */
export interface AuthentikUserRecord {
  pk: number | string;
  username: string;
  email: string;
  is_active: boolean;
}

export interface FakeSeed {
  /** users.yaml body served by the fake GitHub contents API. */
  usersYaml: string;
  /** Local Jellyfin accounts that already exist on the server. */
  jellyfinUsers: JellyfinUserRecord[];
  /** API keys the server accepts as a valid service token. */
  validApiKeys: string[];
  /** Pre-seeded OpenBao KV entries, keyed by logical path (no mount / `data/`). */
  vault: Record<string, unknown>;
  /** Authentik identities resolvable via `/api/v3/core/users/?username=|email=`. */
  authentikUsers: AuthentikUserRecord[];
}

export interface FakeBackends {
  baseUrl: string;
  /** Live view of the Jellyfin account table, for assertions. */
  jellyfinUsers(): JellyfinUserRecord[];
  /** Current stored value at an OpenBao logical path, or undefined. */
  vaultRead(logicalPath: string): unknown;
  /** Authenticate against the fake Jellyfin exactly as a native client would. */
  authenticate(username: string, password: string): Promise<number>;
  close(): Promise<void>;
}

const TOKEN_RE = /Token="([^"]+)"/;

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      if (!raw) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(undefined);
      }
    });
  });
}

function send(res: ServerResponse, status: number, body?: unknown): void {
  if (body === undefined) {
    res.writeHead(status);
    res.end();
    return;
  }
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(payload);
}

export async function startFakeBackends(seed: FakeSeed): Promise<FakeBackends> {
  // Deep-copy the seed so a test mutating server state never leaks into the next.
  const users: JellyfinUserRecord[] = seed.jellyfinUsers.map((u) => ({ ...u }));
  const apiKeys = new Set(seed.validApiKeys);
  const vault = new Map<string, unknown>(Object.entries(seed.vault));
  const authentikUsers: AuthentikUserRecord[] = seed.authentikUsers.map((u) => ({ ...u }));

  const userDto = (u: JellyfinUserRecord) => ({
    Id: u.Id,
    Name: u.Name,
    Policy: { IsAdministrator: u.IsAdministrator, IsDisabled: u.IsDisabled },
  });
  const findUser = (id: string) => users.find((u) => u.Id === id);
  const findByName = (name: string) => users.find((u) => u.Name.toLowerCase() === name.toLowerCase());
  const tokenOf = (req: IncomingMessage) => TOKEN_RE.exec(req.headers["authorization"] ?? "")?.[1];
  const authed = (req: IncomingMessage) => {
    const t = tokenOf(req);
    return t !== undefined && apiKeys.has(t);
  };

  async function handleJellyfin(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
    const method = req.method ?? "GET";

    if (method === "GET" && path === "/System/Info/Public") return send(res, 200, { StartupWizardCompleted: true }), true;
    if (method === "GET" && path === "/System/Info") return send(res, authed(req) ? 200 : 401, authed(req) ? { Version: "10.11.11" } : undefined), true;

    if (method === "GET" && path === "/Users") {
      if (!authed(req)) return send(res, 401), true;
      return send(res, 200, users.map(userDto)), true;
    }
    if (method === "POST" && path === "/Users/New") {
      if (!authed(req)) return send(res, 401), true;
      const body = (await readJson(req)) as { Name?: string; Password?: string };
      const created: JellyfinUserRecord = {
        Id: `guid-${body.Name}`,
        Name: String(body.Name),
        password: String(body.Password ?? ""),
        IsAdministrator: false,
        IsDisabled: false,
      };
      users.push(created);
      return send(res, 200, userDto(created)), true;
    }

    // Native-client sign-in — matched before the generic /Users/:id routes below,
    // which it would otherwise fall into (and be rejected by their auth guard).
    if (method === "POST" && path === "/Users/AuthenticateByName") {
      const body = (await readJson(req)) as { Username?: string; Pw?: string };
      const user = findByName(String(body.Username));
      if (!user || user.IsDisabled || user.password !== String(body.Pw)) return send(res, 401), true;
      return send(res, 200, { AccessToken: `session-${user.Name}` }), true;
    }

    const userMatch = /^\/Users\/([^/]+)(\/Policy|\/Password)?$/.exec(path);
    if (userMatch) {
      if (!authed(req)) return send(res, 401), true;
      const user = findUser(decodeURIComponent(userMatch[1]));
      if (!user) return send(res, 404), true;
      const sub = userMatch[2];
      if (method === "GET" && !sub) return send(res, 200, userDto(user)), true;
      if (method === "POST" && sub === "/Policy") {
        const policy = (await readJson(req)) as { IsAdministrator?: boolean; IsDisabled?: boolean };
        if (typeof policy.IsAdministrator === "boolean") user.IsAdministrator = policy.IsAdministrator;
        if (typeof policy.IsDisabled === "boolean") user.IsDisabled = policy.IsDisabled;
        return send(res, 204), true;
      }
      if (method === "POST" && sub === "/Password") {
        const body = (await readJson(req)) as { NewPw?: string };
        user.password = String(body.NewPw ?? "");
        return send(res, 204), true;
      }
    }

    // Bootstrap endpoints — only reached if the stored-API-key fast path misses.
    if (method === "GET" && path === "/Auth/Keys") return send(res, 200, { Items: [...apiKeys].map((k) => ({ AccessToken: k, AppName: "InfraWeaver" })) }), true;
    return false;
  }

  function vaultPathParts(path: string): { kind: "data" | "metadata"; logical: string } | null {
    const m = /^\/v1\/[^/]+\/(data|metadata)\/(.+)$/.exec(path);
    return m ? { kind: m[1] as "data" | "metadata", logical: m[2] } : null;
  }

  async function handleVault(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
    const parts = vaultPathParts(path);
    if (!parts) return false;
    const method = req.method ?? "GET";
    if (parts.kind === "metadata" && method === "DELETE") {
      vault.delete(parts.logical);
      return send(res, 204), true;
    }
    if (parts.kind === "data" && method === "GET") {
      if (!vault.has(parts.logical)) return send(res, 404, { errors: [] }), true;
      return send(res, 200, { data: { data: vault.get(parts.logical), metadata: { version: 1 } } }), true;
    }
    if (parts.kind === "data" && method === "POST") {
      const body = (await readJson(req)) as { data?: unknown };
      vault.set(parts.logical, body?.data ?? {});
      return send(res, 200, { data: { version: 1 } }), true;
    }
    return false;
  }

  function handleGitHub(req: IncomingMessage, res: ServerResponse, path: string): boolean {
    const m = /^\/repos\/[^/]+\/[^/]+\/contents\/(.+)$/.exec(path);
    if (!m) return false;
    if (decodeURIComponent(m[1]) !== "users.yaml") return send(res, 404, { message: "Not Found" }), true;
    return send(res, 200, {
      type: "file",
      path: "users.yaml",
      sha: "fake-users-sha",
      content: Buffer.from(seed.usersYaml, "utf-8").toString("base64"),
      encoding: "base64",
    }), true;
  }

  // Authentik identity lookup — `lib/authentik.ts#findUserBy` hits
  // `/api/v3/core/users/?username=<u>` (or `?email=<e>`) and reads `results[0]`.
  // Return the first seeded record matching the queried field, or an empty list
  // (which resolves to `null`, exactly as the real API's no-match response does).
  function handleAuthentik(res: ServerResponse, path: string, query: string): boolean {
    if (path !== "/api/v3/core/users/") return false;
    const params = new URLSearchParams(query);
    const username = params.get("username");
    const email = params.get("email");
    const match = authentikUsers.find(
      (u) => (username !== null && u.username === username) || (email !== null && u.email === email),
    );
    return send(res, 200, { results: match ? [match] : [] }), true;
  }

  const server: Server = createServer((req, res) => {
    const url = req.url ?? "";
    const qIndex = url.indexOf("?");
    const path = qIndex === -1 ? url : url.slice(0, qIndex);
    const query = qIndex === -1 ? "" : url.slice(qIndex + 1);
    void (async () => {
      try {
        if (path.startsWith("/v1/")) {
          if (await handleVault(req, res, path)) return;
        } else if (path.startsWith("/repos/")) {
          if (handleGitHub(req, res, path)) return;
        } else if (path.startsWith("/api/v3/")) {
          if (handleAuthentik(res, path, query)) return;
        } else if (await handleJellyfin(req, res, path)) {
          return;
        }
        send(res, 500, { error: `unhandled ${req.method} ${path}` });
      } catch (err) {
        send(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    baseUrl,
    jellyfinUsers: () => users.map((u) => ({ ...u })),
    vaultRead: (logical) => vault.get(logical),
    async authenticate(username, password) {
      const res = await fetch(`${baseUrl}/Users/AuthenticateByName`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ Username: username, Pw: password }),
      });
      return res.status;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
