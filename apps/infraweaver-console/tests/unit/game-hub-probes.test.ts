import {
  buildProbeExecCommand,
  buildUniversalGameServerProbes,
} from "@/lib/game-hub-probes";

// The probe must be entrypoint-agnostic. Two real-world styles have to work:
//
//   1. exec-as-PID-1 yolks (dotnet/Terraria): the game IS PID 1, so it has no
//      children. A `pgrep -P 1` check alone never passes -> the container never
//      reaches Ready. The port-binding check is what rescues this case.
//   2. wrapper/child-process eggs (Minecraft): a shell is PID 1 and forks the
//      game. `pgrep -P 1` passes even before the socket is bound.
//
// Plus UDP-only servers (Valheim) must not depend on a TCP LISTEN check.
describe("buildProbeExecCommand", () => {
  function script(command: string[]): string {
    expect(command.slice(0, 2)).toEqual(["sh", "-c"]);
    return command[2];
  }

  it("checks a bound TCP port in LISTEN state (exec-as-PID-1 Terraria on :7777)", () => {
    // 7777 -> 0x1E61
    const cmd = script(buildProbeExecCommand([{ port: 7777, protocol: "TCP" }]));
    expect(cmd).toContain(":1E61");
    // TCP requires the LISTEN state field (0A) so a live socket, not the process
    // tree, is what marks the exec-as-PID-1 game ready.
    expect(cmd).toMatch(/:1E61 \[0-9A-F\]\+:\[0-9A-F\]\+ 0A /);
    expect(cmd).toContain("/proc/net/tcp");
    expect(cmd).toContain("/proc/net/tcp6");
  });

  it("still falls back to the child-process check for wrapper eggs (Minecraft)", () => {
    const cmd = script(buildProbeExecCommand([{ port: 25565, protocol: "TCP" }]));
    // 25565 -> 0x63DD
    expect(cmd).toContain(":63DD");
    // The wrapper-style entrypoint forks the game; pgrep -P 1 bridges the window
    // before the JVM binds its socket.
    expect(cmd).toContain("pgrep -P 1");
  });

  it("checks a bound UDP port WITHOUT a LISTEN state for UDP-only servers (Valheim :2456)", () => {
    // 2456 -> 0x0998
    const cmd = script(buildProbeExecCommand([{ port: 2456, protocol: "UDP" }]));
    expect(cmd).toContain(":0998");
    expect(cmd).toContain("/proc/net/udp");
    expect(cmd).toContain("/proc/net/udp6");
    // UDP is connectionless: must NOT require the TCP LISTEN (0A) state, or it
    // would never pass.
    expect(cmd).not.toMatch(/:0998 \[0-9A-F\]\+:\[0-9A-F\]\+ 0A/);
    // and must not look in the TCP tables for this port
    expect(cmd).not.toMatch(/proc\/net\/tcp[^ ]*"[^|]*:0998/);
  });

  it("guards each /proc/net file so a missing IPv6 table cannot poison exit status", () => {
    const cmd = script(buildProbeExecCommand([{ port: 7777, protocol: "TCP" }]));
    expect(cmd).toContain("[ -r /proc/net/tcp ]");
    expect(cmd).toContain("[ -r /proc/net/tcp6 ]");
  });

  it("supports multiple ports (game + query) joined as alternatives", () => {
    // 27015 -> 0x6987 (query), 7777 -> 0x1E61 (game)
    const cmd = script(
      buildProbeExecCommand([
        { port: 7777, protocol: "TCP" },
        { port: 27015, protocol: "UDP" },
      ]),
    );
    expect(cmd).toContain(":1E61");
    expect(cmd).toContain(":6987");
    expect(cmd.split("||").length).toBeGreaterThan(2);
  });

  it("degrades to the child-process check alone when no ports are known", () => {
    const cmd = script(buildProbeExecCommand());
    expect(cmd).toBe("pgrep -P 1 > /dev/null 2>&1");
  });

  it("defaults an unspecified protocol to TCP", () => {
    const cmd = script(buildProbeExecCommand([{ port: 7777 }]));
    expect(cmd).toContain("/proc/net/tcp");
    expect(cmd).not.toContain("/proc/net/udp");
  });

  it("omits the child-process fallback when childProcessFallback is false", () => {
    // This is the readiness shape: a bound socket is the only thing that marks
    // the server Ready. A live child of PID 1 (hung/corrupt steamcmd under a
    // wrapper) must NOT count.
    const cmd = script(
      buildProbeExecCommand([{ port: 7777, protocol: "TCP" }], { childProcessFallback: false }),
    );
    expect(cmd).toContain(":1E61");
    expect(cmd).not.toContain("pgrep -P 1");
  });

  it("force-keeps the child check even with childProcessFallback:false when no ports are known", () => {
    // Dropping the fallback with no port to check would leave an empty (always
    // failing) command and wedge the server NotReady forever. Guard against it.
    const cmd = script(buildProbeExecCommand([], { childProcessFallback: false }));
    expect(cmd).toBe("pgrep -P 1 > /dev/null 2>&1");
  });
});

describe("buildUniversalGameServerProbes", () => {
  it("keeps the child-process bridge on startup + liveness but drops it from readiness", () => {
    const probes = buildUniversalGameServerProbes(10, [{ port: 7777, protocol: "TCP" }]);
    const startup = probes.startupProbe?.exec?.command;
    const liveness = probes.livenessProbe?.exec?.command;
    const readiness = probes.readinessProbe?.exec?.command;

    // startup + liveness share the bridged command so a slow-booting wrapper egg
    // is not failed/killed before it binds its socket.
    expect(startup).toEqual(liveness);
    expect(startup?.[2]).toContain(":1E61");
    expect(startup?.[2]).toContain("pgrep -P 1");

    // readiness requires an actually-bound port and drops the child fallback:
    // this is what closes the SteamCMD silent-install gap.
    expect(readiness?.[2]).toContain(":1E61");
    expect(readiness?.[2]).not.toContain("pgrep -P 1");
    expect(readiness).not.toEqual(startup);
  });

  it("marks a wrapper egg NotReady until the port binds while startup still passes (SteamCMD gap)", () => {
    // 25565 -> 0x63DD. A wrapper egg (steamcmd under /start.sh) keeps a live
    // child of PID 1 the whole time it downloads. startup bridges on that child
    // so the slow window doesn't fail; readiness ignores it and keys only off the
    // bound socket, so a hung/corrupt download reports NotReady instead of green.
    const probes = buildUniversalGameServerProbes(20, [{ port: 25565, protocol: "TCP" }]);
    expect(probes.startupProbe?.exec?.command?.[2]).toContain("pgrep -P 1");
    const readiness = probes.readinessProbe?.exec?.command?.[2] ?? "";
    expect(readiness).toContain(":63DD");
    expect(readiness).not.toContain("pgrep -P 1");
  });

  it("sizes the startup window from startupMinutes (20s period)", () => {
    const short = buildUniversalGameServerProbes(10, [{ port: 7777 }]);
    const heavy = buildUniversalGameServerProbes(20, [{ port: 7777 }]);
    // ceil(minutes*60 / 20)
    expect(short.startupProbe?.failureThreshold).toBe(30);
    expect(heavy.startupProbe?.failureThreshold).toBe(60);
  });

  it("falls back to the child check on readiness when no ports are known (back-compat, avoids wedging)", () => {
    const probes = buildUniversalGameServerProbes();
    expect(probes.readinessProbe?.exec?.command).toEqual([
      "sh",
      "-c",
      "pgrep -P 1 > /dev/null 2>&1",
    ]);
  });
});
