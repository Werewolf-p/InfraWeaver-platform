import type * as k8s from "@kubernetes/client-node";
import type { EggConfigFiles, GameEgg } from "./game-eggs";

/**
 * Name of the shared ConfigMap that ships the boot-time egg config-file parser
 * (parse.py). One copy per namespace: every game server pod projects it read-only
 * at /opt/iw and runs it from a `config-sync` init container on each start.
 */
export const EGG_CONFIG_PARSER_CONFIGMAP = "game-hub-egg-config-parser";

// server.properties is always a "properties"-parser file; used when we synthesize
// the RCON block for an RCON-capable egg that does not already declare one.
const PROPERTIES_PARSER = "properties" as const;

/**
 * Exact contents of the shared boot-time templater (parse.py), embedded verbatim
 * so the runtime ConfigMap matches the reviewed source byte-for-byte. Backslashes,
 * backticks and ${ are escaped for the template literal; the value is identical to
 * the source file. See buildEggConfigParserConfigMap.
 */
const PARSE_PY = `#!/usr/bin/env python3
"""InfraWeaver generic egg config-file templater (boot-time).

Reimplements the Pterodactyl/Pelican "configuration files" parser so that game
servers ported to raw Kubernetes (no wings) still get their config files
templated from environment variables on EVERY boot — not just at install time.

Driven entirely by the egg's own \`config.files\` spec (passed as IW_CONFIG_FILES),
so it is generic across all eggs. No per-server logic.

Inputs (env):
  IW_CONFIG_FILES  JSON. Pterodactyl form: {"<path>": {"parser": "...", "find": {...}}}
                   (an array of {file,parser,find} is also accepted defensively).
  IW_DATA_DIR      base dir the paths are relative to (default /home/container).
  <all server env> used to resolve {{server.build.env.NAME}} tokens.

Supported parsers: properties, file, yaml, json, ini, xml.
Never fatal on a single file/parser error — logs and continues so one bad entry
cannot wedge server boot.
"""
import configparser
import io
import json
import os
import re
import sys
import xml.etree.ElementTree as ET

DATA_DIR = os.environ.get("IW_DATA_DIR", "/home/container")
SECRET_HINT = re.compile(r"(pass|secret|token|rcon|key)", re.IGNORECASE)


def log(msg):
    print(f"[egg-config] {msg}", flush=True)


def _owner_of(path):
    """uid/gid of the data dir, so templated files keep the game user's ownership
    (the init may run as root to install pyyaml; the server runs as 1000)."""
    try:
        st = os.stat(path)
        return st.st_uid, st.st_gid
    except OSError:
        return None


_DATA_OWNER = _owner_of(DATA_DIR)


def preserve_owner(path):
    if _DATA_OWNER is None or os.geteuid() != 0:
        return
    try:
        os.chown(path, _DATA_OWNER[0], _DATA_OWNER[1])
    except OSError as exc:
        log(f"WARN could not chown {os.path.basename(path)}: {exc}")


def redact(key, value):
    return "***" if SECRET_HINT.search(str(key)) else str(value)


# ---- token resolution ------------------------------------------------------
_TOKEN = re.compile(r"\\{\\{\\s*([^}]+?)\\s*\\}\\}")


def _resolve_one(expr):
    expr = expr.strip()
    if expr.startswith("server.build.env."):
        return os.environ.get(expr[len("server.build.env."):], "")
    known = {
        "server.build.default.port": os.environ.get("SERVER_PORT", ""),
        "server.build.default.ip": "0.0.0.0",
        "server.build.memory": os.environ.get("SERVER_MEMORY", ""),
        "config.docker.interface": "0.0.0.0",
        "server.build.env.SERVER_PORT": os.environ.get("SERVER_PORT", ""),
    }
    if expr in known:
        return known[expr]
    # Unknown token: wings substitutes empty. Warn so it's visible.
    log(f"WARN unresolved token {{{{{expr}}}}} -> empty")
    return ""


def resolve(value):
    if not isinstance(value, str):
        return value
    return _TOKEN.sub(lambda m: _resolve_one(m.group(1)), value)


def coerce(value):
    """Coerce resolved string to bool/int for structured formats (yaml/json)."""
    if not isinstance(value, str):
        return value
    low = value.lower()
    if low == "true":
        return True
    if low == "false":
        return False
    if re.fullmatch(r"-?\\d+", value):
        try:
            return int(value)
        except ValueError:
            pass
    return value


def set_nested(obj, dotted, value):
    parts = dotted.split(".")
    cur = obj
    for p in parts[:-1]:
        nxt = cur.get(p)
        if not isinstance(nxt, dict):
            nxt = {}
            cur[p] = nxt
        cur = nxt
    cur[parts[-1]] = value


# ---- parsers ---------------------------------------------------------------
def parse_properties(path, find):
    lines = []
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            lines = fh.read().splitlines()
    remaining = dict(find)
    out = []
    for line in lines:
        m = re.match(r"^(\\s*)([^#=\\s][^=]*?)(\\s*=\\s*)(.*)$", line)
        if m and m.group(2).strip() in remaining:
            key = m.group(2).strip()
            val = resolve(remaining.pop(key))
            out.append(f"{m.group(1)}{key}={val}")
            log(f"{os.path.basename(path)}: set {key}={redact(key, val)}")
        else:
            out.append(line)
    for key, raw in remaining.items():
        val = resolve(raw)
        out.append(f"{key}={val}")
        log(f"{os.path.basename(path)}: append {key}={redact(key, val)}")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write("\\n".join(out) + "\\n")


def parse_file(path, find):
    """Line-oriented regex replace: each find key is a regex, value the line replacement."""
    content = ""
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            content = fh.read()
    for pattern, repl in find.items():
        val = resolve(repl)
        try:
            content = re.sub(pattern, val, content, flags=re.MULTILINE)
            log(f"{os.path.basename(path)}: regex {pattern!r} -> {redact(pattern, val)}")
        except re.error as exc:
            log(f"ERROR {os.path.basename(path)}: bad regex {pattern!r}: {exc}")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(content)


def parse_structured(path, find, fmt):
    if fmt == "yaml":
        try:
            import yaml  # type: ignore
        except ImportError:
            log(f"ERROR {os.path.basename(path)}: yaml parser needs PyYAML — skipped")
            return
        loader = lambda s: yaml.safe_load(s) or {}
        dumper = lambda o: yaml.safe_dump(o, default_flow_style=False, sort_keys=False)
    else:
        loader = lambda s: json.loads(s) if s.strip() else {}
        dumper = lambda o: json.dumps(o, indent=2)
    data = {}
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            try:
                data = loader(fh.read())
            except Exception as exc:  # noqa: BLE001 - never fatal
                log(f"ERROR {os.path.basename(path)}: parse failed ({exc}); recreating")
                data = {}
    if not isinstance(data, dict):
        data = {}
    for dotted, raw in find.items():
        val = coerce(resolve(raw))
        set_nested(data, dotted, val)
        log(f"{os.path.basename(path)}: set {dotted}={redact(dotted, val)}")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(dumper(data))


def parse_ini(path, find):
    cp = configparser.ConfigParser()
    cp.optionxform = str  # preserve key case
    if os.path.exists(path):
        try:
            cp.read(path, encoding="utf-8")
        except configparser.Error as exc:
            log(f"ERROR {os.path.basename(path)}: ini read failed ({exc}); recreating")
    for dotted, raw in find.items():
        val = resolve(raw)
        if "." in dotted:
            section, key = dotted.split(".", 1)
        else:
            section, key = "DEFAULT", dotted
        if section != "DEFAULT" and not cp.has_section(section):
            cp.add_section(section)
        cp.set(section, key, val)
        log(f"{os.path.basename(path)}: [{section}] {key}={redact(key, val)}")
    buf = io.StringIO()
    cp.write(buf)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(buf.getvalue())


def parse_xml(path, find):
    if os.path.exists(path):
        try:
            tree = ET.parse(path)
            root = tree.getroot()
        except ET.ParseError as exc:
            log(f"ERROR {os.path.basename(path)}: xml parse failed ({exc}); skipped")
            return
    else:
        log(f"ERROR {os.path.basename(path)}: xml file missing; skipped")
        return
    for dotted, raw in find.items():
        val = resolve(raw)
        parts = dotted.split(".")
        # Path may or may not include the root element as first segment.
        rel = parts[1:] if parts and parts[0] == root.tag else parts
        node = root
        ok = True
        for p in rel:
            child = node.find(p)
            if child is None:
                child = ET.SubElement(node, p)
            node = child
        if ok:
            node.text = val
            log(f"{os.path.basename(path)}: <{dotted}>={redact(dotted, val)}")
    tree.write(path, encoding="utf-8", xml_declaration=True)


PARSERS = {
    "properties": parse_properties,
    "file": parse_file,
    "ini": parse_ini,
    "xml": parse_xml,
}


def normalize_spec(raw):
    """Return list of (relpath, parser, find) from either object or array form."""
    entries = []
    if isinstance(raw, dict):
        for path, spec in raw.items():
            if isinstance(spec, dict):
                entries.append((path, spec.get("parser", "file"), spec.get("find", {}) or {}))
    elif isinstance(raw, list):
        for spec in raw:
            if isinstance(spec, dict):
                path = spec.get("file") or spec.get("path")
                if path:
                    entries.append((path, spec.get("parser", "file"), spec.get("find", {}) or {}))
    return entries


def main():
    raw = os.environ.get("IW_CONFIG_FILES", "").strip()
    if not raw:
        log("no IW_CONFIG_FILES — nothing to template")
        return 0
    try:
        spec = json.loads(raw)
    except json.JSONDecodeError as exc:
        log(f"ERROR IW_CONFIG_FILES is not valid JSON: {exc}")
        return 0  # never block boot
    entries = normalize_spec(spec)
    if not entries:
        log("config.files spec empty — nothing to template")
        return 0
    for relpath, parser, find in entries:
        path = relpath if os.path.isabs(relpath) else os.path.join(DATA_DIR, relpath)
        os.makedirs(os.path.dirname(path) or DATA_DIR, exist_ok=True)
        find = {k: v for k, v in find.items()}
        log(f"applying parser={parser} file={relpath} ({len(find)} keys)")
        try:
            if parser in ("yaml", "json"):
                parse_structured(path, find, parser)
            elif parser in PARSERS:
                PARSERS[parser](path, find)
            else:
                log(f"WARN unknown parser {parser!r} for {relpath} — treating as 'file'")
                parse_file(path, find)
        except Exception as exc:  # noqa: BLE001 - one file must not wedge boot
            log(f"ERROR templating {relpath}: {exc}")
        else:
            if os.path.exists(path):
                preserve_owner(path)
    log("done")
    return 0


if __name__ == "__main__":
    sys.exit(main())
`;

/**
 * Build the shared parser ConfigMap for a namespace. The data never varies per
 * server, so all game servers in the namespace share one copy; callers apply it
 * idempotently (create-or-replace). `parse.py` is mounted (mode 0755) into each
 * pod's config-sync init container.
 */
export function buildEggConfigParserConfigMap(namespace: string): k8s.V1ConfigMap {
  return {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: {
      name: EGG_CONFIG_PARSER_CONFIGMAP,
      namespace,
      labels: {
        "infraweaver.io/type": "game-egg-config-parser",
      },
    },
    data: {
      "parse.py": PARSE_PY,
    },
  };
}

/**
 * Whether an egg speaks RCON and therefore needs its server.properties templated
 * with the RCON block on every boot. isMinecraftGame is not exported from
 * game-hub-server, so we use a structural signal: the egg already declares a
 * server.properties config file, or its environment schema carries RCON_PASSWORD.
 */
function isRconCapableEgg(egg: GameEgg): boolean {
  const hasPropertiesEntry = Object.keys(egg.configFiles ?? {}).some(
    (path) => path.split("/").pop() === "server.properties",
  );
  const hasRconEnv = (egg.environment ?? []).some((entry) => entry.name === "RCON_PASSWORD");
  return hasPropertiesEntry || hasRconEnv;
}

/**
 * Compute the config-file spec to template at boot. Starts from the egg's own
 * `config.files` (deep-cloned — the egg is never mutated) and, for RCON-capable
 * eggs, ensures a server.properties entry carrying the RCON block so
 * Minecraft-family servers get enable-rcon / rcon.port / rcon.password written on
 * every start (wings did this each boot; the raw-k8s port dropped it).
 * Egg-declared find keys always win over the synthesized RCON defaults.
 *
 * Returns {} unchanged when the egg has no config files and is not RCON-capable —
 * callers skip the config-sync init entirely in that case.
 */
export function computeEffectiveConfigFiles(egg: GameEgg): EggConfigFiles {
  const base: EggConfigFiles = structuredClone(egg.configFiles ?? {});
  if (!isRconCapableEgg(egg)) {
    return base;
  }

  const rconFind: Record<string, string> = {
    "enable-rcon": "true",
    "rcon.port": "{{server.build.env.RCON_PORT}}",
    "rcon.password": "{{server.build.env.RCON_PASSWORD}}",
  };

  const existing = base["server.properties"];
  base["server.properties"] = {
    parser: existing?.parser ?? PROPERTIES_PARSER,
    // Merge so the egg's own keys are never clobbered — RCON defaults only fill
    // gaps the egg leaves open.
    find: { ...rconFind, ...(existing?.find ?? {}) },
  };
  return base;
}

/**
 * Build the boot-time `config-sync` init container. It runs the shared parser
 * (parse.py) against the egg's effective config.files on every pod start,
 * templating config files (e.g. server.properties) from environment variables —
 * the job wings performed each boot that the raw-k8s port dropped.
 *
 * `opts.env` is carried EXACTLY as the main game container carries it: plain
 * name/value pairs. createServer resolves RCON_PASSWORD to a concrete generated
 * value in allEnv (there is no valueFrom.secretKeyRef in that path), so the init
 * resolves the identical RCON password the game server uses.
 */
export function buildConfigSyncInitContainer(opts: {
  egg: GameEgg;
  env: Record<string, string>;
  effective: EggConfigFiles;
}): k8s.V1Container {
  const { egg, env, effective } = opts;
  // Ensure PyYAML is available for eggs whose config.files use the yaml parser,
  // then run the templater. Never fatal: a failed apk add falls through to
  // `|| true`, and parse.py skips yaml files when the module is still missing.
  const bootstrap = "python3 -c 'import yaml' 2>/dev/null || apk add --no-cache py3-yaml >/dev/null 2>&1 || true";
  const script = bootstrap + "\n" + "exec python3 /opt/iw/parse.py";

  return {
    name: "config-sync",
    image: "python:3.12-alpine",
    imagePullPolicy: "IfNotPresent",
    securityContext: { runAsUser: 0, runAsGroup: 0 },
    command: ["/bin/sh", "-lc"],
    args: [script],
    env: [
      ...Object.entries(env).map(([name, value]) => ({ name, value })),
      { name: "IW_DATA_DIR", value: egg.mountPath },
      { name: "IW_CONFIG_FILES", value: JSON.stringify(effective) },
    ],
    volumeMounts: [
      { name: "data", mountPath: egg.mountPath },
      { name: "egg-config-parser", mountPath: "/opt/iw", readOnly: true },
    ],
  };
}
