import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, win32 } from "node:path";
import {
  isForbiddenShellPath,
  createCustomCandidate,
  type BackendId,
  type BackendSelection,
} from "./backends.ts";

function getAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

const STATE_VERSION = 1;
const DEFAULT_STATE_NAME = "pi-bash-bg.json";

const VALID_BACKENDS = new Set<BackendId>([
  "auto",
  "gitbash",
  "pwsh7",
  "powershell51",
  "custom",
]);

export interface BackendStateLoad {
  selection: BackendSelection;
  warning?: string;
}

export interface BackendStateStore {
  readonly statePath: string;
  read(): BackendStateLoad;
  write(selection: BackendSelection): void;
}

interface StoredState {
  version: number;
  backend: BackendId;
  shellPath?: string;
  updatedAt: string;
}

function defaultSelection(): BackendSelection {
  return { backend: "auto" };
}

function absolutePath(value: string): boolean {
  return isAbsolute(value) || win32.isAbsolute(value);
}

function usableShellFile(value: string): boolean {
  if (!existsSync(value)) return false;
  const name = basename(value.replaceAll("\\", "/")).toLowerCase();
  if (
    !["bash", "bash.exe", "pwsh", "pwsh.exe", "powershell", "powershell.exe"].includes(name)
  ) {
    return false;
  }
  try {
    return statSync(value).isFile();
  } catch {
    return false;
  }
}

function invalid(message: string): BackendStateLoad {
  return {
    selection: defaultSelection(),
    warning: `${message}; using auto backend`,
  };
}


function parseStoredState(raw: unknown): BackendSelection | string {
  if (!raw || typeof raw !== "object") return "state must be a JSON object";
  const value = raw as Partial<StoredState>;
  if (value.version !== STATE_VERSION) {
    return `unsupported state version: ${String(value.version)}`;
  }
  if (typeof value.backend !== "string" || !VALID_BACKENDS.has(value.backend)) {
    return `unknown backend: ${String(value.backend)}`;
  }
  if (value.shellPath !== undefined && typeof value.shellPath !== "string") {
    return "shellPath must be a string";
  }
  if (value.shellPath && isForbiddenShellPath(value.shellPath)) {
    return `cmd.exe is not an allowed shell backend: ${value.shellPath}`;
  }
  if (value.backend === "custom") {
    if (!value.shellPath) return "custom backend requires shellPath";
    if (!absolutePath(value.shellPath)) return "custom shellPath must be absolute";
    if (!usableShellFile(value.shellPath)) {
      return `custom shellPath is not a Bash or PowerShell executable: ${value.shellPath}`;
    }
  }
  return {
    backend: value.backend,
    ...(value.backend === "custom" && value.shellPath
      ? { shellPath: value.shellPath }
      : {}),
  };
}

export function defaultBackendStatePath(): string {
  return join(getAgentDir(), DEFAULT_STATE_NAME);
}

export function createBackendStateStore(options?: {
  statePath?: string;
}): BackendStateStore {
  const statePath = options?.statePath ?? defaultBackendStatePath();

  function read(): BackendStateLoad {
    if (!existsSync(statePath)) return { selection: defaultSelection() };
    let rawText: string;
    try {
      rawText = readFileSync(statePath, "utf8");
    } catch (error) {
      return invalid(
        `unable to read backend state: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch (error) {
      return invalid(
        `invalid backend state JSON: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    const selection = parseStoredState(parsed);
    if (typeof selection === "string") {
      return invalid(`invalid backend state: ${selection}`);
    }
    if (selection.backend === "custom" && selection.shellPath) {
      try {
        createCustomCandidate(selection.shellPath);
      } catch (error) {
        return invalid(
          `invalid backend state: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    return { selection };
  }

  function write(selection: BackendSelection): void {
    const validation = parseStoredState({
      version: STATE_VERSION,
      backend: selection.backend,
      shellPath: selection.shellPath,
    });
    if (typeof validation === "string") {
      throw new Error(`Cannot save backend selection: ${validation}`);
    }
    if (validation.backend === "custom" && validation.shellPath) {
      try {
        createCustomCandidate(validation.shellPath);
      } catch (error) {
        throw new Error(
          `Cannot save backend selection: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    mkdirSync(dirname(statePath), { recursive: true });
    const stored: StoredState = {
      version: STATE_VERSION,
      backend: validation.backend,
    ...(validation.backend === "custom" && validation.shellPath
      ? { shellPath: validation.shellPath }
      : {}),
      updatedAt: new Date().toISOString(),
    };
    const temporaryPath = join(
      dirname(statePath),
      `.${basename(statePath)}.${randomBytes(6).toString("hex")}.tmp`,
    );
    try {
      writeFileSync(temporaryPath, `${JSON.stringify(stored, null, 2)}\n`, "utf8");
      renameSync(temporaryPath, statePath);
    } finally {
      try {
        if (existsSync(temporaryPath)) {
          unlinkSync(temporaryPath);
        }
      } catch {
        // The primary write error is more useful than cleanup errors.
      }
    }
  }

  return { statePath, read, write };
}
