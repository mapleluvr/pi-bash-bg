import { accessSync, constants, existsSync, realpathSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, delimiter, isAbsolute, join, win32 } from "node:path";

export type BackendId =
  | "auto"
  | "bash"
  | "gitbash"
  | "pwsh7"
  | "powershell51"
  | "custom";

export type BackendKind = "bash" | "powershell";

export interface BackendCandidate {
  id: Exclude<BackendId, "auto">;
  kind: BackendKind;
  label: string;
  path: string;
  args: string[];
  commandTransport: "argv" | "stdin";
  version?: string;
}

export interface BackendSelection {
  backend: BackendId;
  shellPath?: string;
}

export interface BackendDiscoveryOptions {
  findOnPath?: (executable: string) => string[];
  probeVersion?: (shellPath: string, args: string[]) => string | undefined;
  programFiles?: string;
  programFilesX86?: string;
}

export function isWindowsPlatform(): boolean {
  return process.platform === "win32";
}

const WINDOWS_AUTO_BACKEND_ORDER = [
  "pwsh7",
  "gitbash",
  "powershell51",
] as const;
const POSIX_AUTO_BACKEND_ORDER = ["bash"] as const;

/**
 * Preferred `auto` order for the current platform. Windows keeps the
 * PowerShell-first order; POSIX systems use their system Bash directly.
 */
export function autoBackendOrder(): readonly Exclude<BackendId, "auto" | "custom">[] {
  return isWindowsPlatform()
    ? WINDOWS_AUTO_BACKEND_ORDER
    : POSIX_AUTO_BACKEND_ORDER;
}

export const AUTO_BACKEND_ORDER = autoBackendOrder();

/**
 * Well-known Bash locations for POSIX systems. PATH is searched first; these
 * are fallbacks for stripped-down environments with a minimal PATH.
 */
const POSIX_BASH_PATHS = [
  "/bin/bash",
  "/usr/bin/bash",
  "/usr/local/bin/bash",
  "/opt/homebrew/bin/bash",
  "/run/current-system/sw/bin/bash",
] as const;

const POWERSHELL_ARGS = [
  "-NoProfile",
  "-NonInteractive",
  "-ExecutionPolicy",
  "Bypass",
  "-Command",
];
const POWERSHELL_VERSION_COMMAND = "$PSVersionTable.PSVersion.ToString()";

function getBashConfig(shellPath: string): {
  args: string[];
  commandTransport: "argv" | "stdin";
} {
  if (!isWindowsPlatform()) return { args: ["-c"], commandTransport: "argv" };
  const normalized = shellPath.replaceAll("/", "\\").toLowerCase();
  const legacyWsl = /^([a-z]:)?\\windows\\(?:system32|sysnative)\\bash\.exe$/.test(
    normalized,
  );
  return legacyWsl
    ? { args: ["-s"], commandTransport: "stdin" }
    : { args: ["-c"], commandTransport: "argv" };
}

function normalizedPath(value: string): string {
  if (!isWindowsPlatform()) {
    // Resolve symlinks so /bin/bash and /usr/bin/bash dedupe on merged-/usr
    // systems; fall back to the literal path when it cannot be resolved.
    try {
      return realpathSync(value);
    } catch {
      return value;
    }
  }
  return value.replaceAll("/", "\\").replaceAll("\\\\", "\\").toLowerCase();
}

export function isForbiddenShellPath(shellPath: string): boolean {
  const normalized = normalizedPath(shellPath);
  const name = basename(shellPath.replaceAll("\\", "/")).toLowerCase();
  return (
    name === "cmd.exe" ||
    normalized.endsWith("\\windows\\system32\\cmd.exe") ||
    normalized.endsWith("\\windows\\sysnative\\cmd.exe")
  );
}

function isAbsoluteShellPath(shellPath: string): boolean {
  return isAbsolute(shellPath) || win32.isAbsolute(shellPath);
}

function isFile(shellPath: string): boolean {
  if (!existsSync(shellPath)) return false;
  try {
    if (!statSync(shellPath).isFile()) return false;
    if (process.platform === "win32") return true;
    accessSync(shellPath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function executableName(shellPath: string): string {
  return basename(shellPath.replaceAll("\\", "/")).toLowerCase();
}

function firstLine(value: string): string | undefined {
  const line = value.trim().split(/\r?\n/, 1)[0]?.trim();
  return line || undefined;
}

function probeVersion(shellPath: string, args: string[]): string | undefined {
  try {
    const result = spawnSync(shellPath, args, {
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
    });
    if (result.status !== 0 || result.error) return undefined;
    return firstLine(result.stdout ?? "");
  } catch {
    return undefined;
  }
}

function versionMajor(version: string | undefined): number | undefined {
  const match = version?.match(/(?:^|\s)(\d+)(?:\.\d+)?/);
  return match ? Number(match[1]) : undefined;
}

function findOnPathPosix(executable: string): string[] {
  // Scan PATH directly instead of shelling out to `which`, which is missing
  // from minimal containers and would spawn an extra process on every load.
  const entries = (process.env.PATH ?? "")
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const found: string[] = [];
  for (const entry of entries) {
    const candidate = join(entry, executable);
    if (isFile(candidate) && !found.includes(candidate)) found.push(candidate);
  }
  return found;
}

function findOnPath(executable: string): string[] {
  if (!isWindowsPlatform()) return findOnPathPosix(executable);
  try {
    const result = spawnSync("where.exe", [executable], {
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
    });
    if (result.status !== 0 || result.error) return [];
    return (result.stdout ?? "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line, index, all) => line.length > 0 && all.indexOf(line) === index)
      .filter(isFile);
  } catch {
    return [];
  }
}

function isBashVersion(version: string | undefined): boolean {
  return Boolean(version && /\b(?:GNU )?bash\b/i.test(version));
}

function bashCandidate(
  id: "bash" | "gitbash" | "custom",
  shellPath: string,
  probe: typeof probeVersion = probeVersion,
): BackendCandidate {
  const config = getBashConfig(shellPath);
  const name = id === "gitbash" ? "Git Bash" : "Bash";

  const version = probe(shellPath, ["--version"]);
  return {
    id,
    kind: "bash",
    label: version ? `${name} (${version})` : `${name} (version unknown)`,
    path: shellPath,
    args: [...config.args],
    commandTransport: config.commandTransport ?? "argv",
    version,
  };
}

function powerShellCandidate(
  id: "pwsh7" | "powershell51" | "custom",
  shellPath: string,
  probe: typeof probeVersion = probeVersion,
): BackendCandidate {
  const version = probe(shellPath, [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    POWERSHELL_VERSION_COMMAND,
  ]);
  const major = versionMajor(version);
  const name =
    id === "pwsh7" ||
    (id === "custom" &&
      (executableName(shellPath) === "pwsh" ||
        executableName(shellPath) === "pwsh.exe" ||
        (major !== undefined && major >= 7)))
      ? "PowerShell 7"
      : "PowerShell 5.1";
  return {
    id,
    kind: "powershell",
    label: version ? `${name} (${version})` : `${name} (version unknown)`,
    path: shellPath,
    args: [...POWERSHELL_ARGS],
    commandTransport: "argv",
    version,
  };
}

function addUnique(
  candidates: BackendCandidate[],
  seen: Set<string>,
  candidateValue: BackendCandidate,
): void {
  if (!isAbsoluteShellPath(candidateValue.path) || !isFile(candidateValue.path)) return;
  const key = normalizedPath(candidateValue.path);
  if (seen.has(key) || isForbiddenShellPath(candidateValue.path)) return;
  seen.add(key);
  candidates.push(candidateValue);
}

function isUsableCandidate(candidate: BackendCandidate): boolean {
  return (
    isAbsoluteShellPath(candidate.path) &&
    isFile(candidate.path) &&
    !isForbiddenShellPath(candidate.path) &&
    Array.isArray(candidate.args) &&
    ["argv", "stdin"].includes(candidate.commandTransport)
  );
}

function isUsableResolvedCandidate(
  candidate: BackendCandidate,
  expectedId: Exclude<BackendId, "auto" | "custom">,
): boolean {
  if (candidate.id !== expectedId || !isUsableCandidate(candidate)) return false;
  return expectedId === "gitbash" || expectedId === "bash"
    ? candidate.kind === "bash"
    : candidate.kind === "powershell";
}

function discoverPosixBash(
  locate: (executable: string) => string[],
  probe: typeof probeVersion,
): BackendCandidate[] {
  const candidates: BackendCandidate[] = [];
  const seen = new Set<string>();
  for (const shellPath of [...locate("bash"), ...POSIX_BASH_PATHS]) {
    if (!isFile(shellPath)) continue;
    try {
      const candidate = bashCandidate("bash", shellPath, probe);
      if (isBashVersion(candidate.version)) {
        addUnique(candidates, seen, candidate);
      }
    } catch {
      // A stale or malformed PATH entry is not a fatal discovery error.
    }
  }
  return candidates;
}

export function discoverBackends(
  options: BackendDiscoveryOptions = {},
): BackendCandidate[] {
  const locate = options.findOnPath ?? findOnPath;
  const probe = options.probeVersion ?? probeVersion;
  if (!isWindowsPlatform()) return discoverPosixBash(locate, probe);

  const candidates: BackendCandidate[] = [];
  const seen = new Set<string>();

  const powerShell7Paths = locate("pwsh.exe");
  for (const shellPath of powerShell7Paths) {
    const version = probe(shellPath, [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      POWERSHELL_VERSION_COMMAND,
    ]);
    if (versionMajor(version) !== undefined && versionMajor(version)! >= 7) {
      addUnique(candidates, seen, powerShellCandidate("pwsh7", shellPath, probe));
    }
  }

  const programFiles = options.programFiles ?? process.env.ProgramFiles;
  const programFilesX86 = options.programFilesX86 ?? process.env["ProgramFiles(x86)"];
  const gitPaths = [
    programFiles ? join(programFiles, "Git", "bin", "bash.exe") : undefined,
    programFilesX86
      ? join(programFilesX86, "Git", "bin", "bash.exe")
      : undefined,
    programFiles ? join(programFiles, "Git", "usr", "bin", "bash.exe") : undefined,
  ].filter((value): value is string => Boolean(value));
  gitPaths.push(...locate("bash.exe"));
  for (const shellPath of gitPaths.filter(isFile)) {
    try {
      const candidate = bashCandidate("gitbash", shellPath, probe);
      if (isBashVersion(candidate.version)) {
        addUnique(candidates, seen, candidate);
      }
    } catch {
      // A stale or malformed PATH entry is not a fatal discovery error.
    }
  }

  const powerShell51Paths = locate("powershell.exe");
  for (const shellPath of powerShell51Paths) {
    const candidate = powerShellCandidate("powershell51", shellPath, probe);
    if (versionMajor(candidate.version) === 5) {
      addUnique(candidates, seen, candidate);
    }
  }

  // PATH probing above is self-contained so loading this extension does not
  // require optional packages imported by the SDK root module.
  return candidates;
}

export function createCustomCandidate(shellPath: string): BackendCandidate {
  if (!isAbsoluteShellPath(shellPath)) {
    throw new Error(`Custom shell path must be absolute: ${shellPath}`);
  }
  if (isForbiddenShellPath(shellPath)) {
    throw new Error(`cmd.exe is not an allowed shell backend: ${shellPath}`);
  }
  if (!isFile(shellPath)) {
    throw new Error(`Custom shell path does not exist or is not executable: ${shellPath}`);
  }

  let candidate: BackendCandidate;
  switch (executableName(shellPath)) {
    case "bash":
    case "bash.exe":
      candidate = bashCandidate("custom", shellPath);
      if (!isBashVersion(candidate.version)) {
        throw new Error(`Custom shell is not Bash: ${shellPath}`);
      }
      break;
    case "pwsh":
    case "pwsh.exe":
    case "powershell":
    case "powershell.exe":
      candidate = powerShellCandidate("custom", shellPath);
      if (!candidate.version || versionMajor(candidate.version) === undefined) {
        throw new Error(`Custom shell is not PowerShell: ${shellPath}`);
      }
      break;
    default:
      throw new Error(
        `Custom shell must be a Bash or PowerShell executable: ${shellPath}`,
      );
  }
  return candidate;
}

export function resolveBackend(
  selection: BackendId | BackendSelection,
  candidates: BackendCandidate[],
): BackendCandidate {
  const backend = typeof selection === "string" ? selection : selection.backend;
  if (backend === "custom") {
    const shellPath = typeof selection === "string" ? undefined : selection.shellPath;
    if (!shellPath) throw new Error("Custom backend requires shellPath");
    return createCustomCandidate(shellPath);
  }

  if (backend === "auto") {
    if (!isWindowsPlatform()) {
      // POSIX exposes no backend selector: use the system Bash, preferring a
      // discovered `bash` candidate and accepting any injected Bash candidate.
      const posix =
        candidates.find(
          (value) => value.id === "bash" && isUsableResolvedCandidate(value, "bash"),
        ) ?? candidates.find((value) => value.kind === "bash" && isUsableCandidate(value));
      if (posix) return posix;
      throw new Error(
        "No shell backend available. Tried: Bash (/bin/bash, /usr/bin/bash, PATH). " +
          "Install bash or make it discoverable on PATH.",
      );
    }
    for (const id of autoBackendOrder()) {
      const candidate = candidates.find(
        (value) => value.id === id && isUsableResolvedCandidate(value, id),
      );
      if (candidate) return candidate;
    }
    throw new Error(
      "No shell backend available. Tried: PowerShell 7, Git Bash, PowerShell 5.1. " +
        "Install one of these backends or select a valid custom path; cmd.exe is not a fallback.",
    );
  }

  const candidate = candidates.find(
    (value) => value.id === backend && isUsableResolvedCandidate(value, backend),
  );
  if (candidate) return candidate;
  const names: Record<Exclude<BackendId, "auto" | "custom">, string> = {
    bash: "Bash",
    pwsh7: "PowerShell 7",
    gitbash: "Git Bash",
    powershell51: "PowerShell 5.1",
  };
  throw new Error(
    `${names[backend]} is not available. Discovered: ${
      candidates.map((value) => value.label).join(", ") || "none"
    }.${isWindowsPlatform() ? " cmd.exe is not a fallback." : ""}`,
  );
}

export function formatBackend(candidate: BackendCandidate): string {
  return `${candidate.label} — ${candidate.path}`;
}
