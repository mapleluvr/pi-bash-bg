import test from "node:test";
import assert from "node:assert/strict";
import { chmod, copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCustomCandidate,
  discoverBackends,
  isWindowsPlatform,
  resolveBackend,
  type BackendCandidate,
} from "../src/backends.ts";

const posixOnly = !isWindowsPlatform();
const windowsOnly = isWindowsPlatform();

function candidate(
  id: BackendCandidate["id"],
  kind: BackendCandidate["kind"],
  path = process.execPath,
): BackendCandidate {
  return {
    id,
    kind,
    label: id,
    path,
    args: kind === "bash" ? ["-c"] : ["-Command"],
    commandTransport: "argv",
    version: "test",
  };
}

test("system backend discovery returns supported candidates without cmd", () => {
  const candidates = discoverBackends();
  assert.doesNotMatch(JSON.stringify(candidates), /cmd\.exe/i);
  for (const candidate of candidates) {
    assert.ok(
      ["bash", "pwsh7", "gitbash", "powershell51", "custom"].includes(candidate.id),
    );
  }
});

test(
  "POSIX discovery finds the system Bash on PATH or at a well-known path",
  { skip: windowsOnly },
  () => {
    const candidates = discoverBackends();
    assert.ok(candidates.length > 0, "expected a discovered Bash backend");
    const bash = candidates.find((value) => value.id === "bash");
    assert.ok(bash, "expected a bash candidate");
    assert.equal(bash.kind, "bash");
    assert.deepEqual(bash.args, ["-c"]);
    assert.equal(bash.commandTransport, "argv");
    assert.match(bash.version ?? "", /bash/i);
    assert.ok(bash.path.startsWith("/"));
  },
);

test(
  "POSIX auto resolves the system Bash without any selection",
  { skip: windowsOnly },
  () => {
    const discovered = discoverBackends();
    const selected = resolveBackend("auto", discovered);
    assert.equal(selected.id, "bash");
    assert.equal(selected.kind, "bash");
  },
);

test(
  "POSIX auto accepts an injected Bash candidate regardless of its id",
  { skip: windowsOnly },
  () => {
    const selected = resolveBackend("auto", [candidate("gitbash", "bash")]);
    assert.equal(selected.kind, "bash");
  },
);

test(
  "POSIX auto failure explains the Bash search instead of suggesting cmd",
  { skip: windowsOnly },
  () => {
    assert.throws(
      () => resolveBackend("auto", []),
      /No shell backend available.*Bash.*\/bin\/bash/i,
    );
  },
);

test(
  "POSIX discovery ignores unprobeable Bash candidates",
  { skip: windowsOnly },
  () => {
    const candidates = discoverBackends({
      findOnPath: () => [process.execPath],
      probeVersion: () => undefined,
    });
    assert.deepEqual(candidates, []);
  },
);

test(
  "Windows auto chooses PowerShell 7 before Git Bash and PowerShell 5.1",
  { skip: posixOnly },
  () => {
    const selected = resolveBackend("auto", [
      candidate("powershell51", "powershell"),
      candidate("gitbash", "bash"),
      candidate("pwsh7", "powershell"),
    ]);
    assert.equal(selected.id, "pwsh7");
  },
);

test(
  "Windows auto falls back to Git Bash before PowerShell 5.1",
  { skip: posixOnly },
  () => {
    const selected = resolveBackend("auto", [
      candidate("powershell51", "powershell"),
      candidate("gitbash", "bash"),
    ]);
    assert.equal(selected.id, "gitbash");
  },
);

test(
  "Windows auto chooses PowerShell 5.1 when it is the only supported backend",
  { skip: posixOnly },
  () => {
    const selected = resolveBackend("auto", [candidate("powershell51", "powershell")]);
    assert.equal(selected.id, "powershell51");
  },
);

test(
  "Windows auto failure lists the three PowerShell/Git Bash backends",
  { skip: posixOnly },
  () => {
    assert.throws(
      () => resolveBackend("auto", []),
      /No shell backend available.*PowerShell 7.*Git Bash.*PowerShell 5\.1/i,
    );
  },
);

test("resolver rejects an injected relative executable candidate", () => {
  assert.throws(
    () => resolveBackend("gitbash", [candidate("gitbash", "bash", "bash.exe")]),
    /absolute|invalid|available/i,
  );
});

test("resolver rejects an injected missing absolute executable candidate", () => {
  assert.throws(
    () =>
      resolveBackend("gitbash", [
        candidate("gitbash", "bash", "C:\\missing\\bash.exe"),
      ]),
    /absolute|missing|available|executable/i,
  );
});

test("explicit backend selection does not use a different discovered backend", () => {
  const selected = resolveBackend("gitbash", [
    candidate("pwsh7", "powershell"),
    candidate("gitbash", "bash"),
  ]);
  assert.equal(selected.id, "gitbash");
});

test(
  "unprobeable pwsh.exe is skipped so auto can use the next backend",
  { skip: posixOnly },
  () => {
    const candidates = discoverBackends({
      findOnPath: (executable) =>
        executable === "pwsh.exe" ? [process.execPath] : [],
      probeVersion: () => undefined,
      programFiles: "",
      programFilesX86: "",
    });
    assert.deepEqual(candidates, []);
  },
);

test(
  "discovery ignores unprobeable Bash and Windows PowerShell candidates",
  { skip: posixOnly },
  () => {
    const candidates = discoverBackends({
      findOnPath: (executable) =>
        executable === "bash.exe" || executable === "powershell.exe"
          ? [process.execPath]
          : [],
      probeVersion: () => undefined,
      programFiles: "",
      programFilesX86: "",
    });
    assert.deepEqual(candidates, []);
  },
);

test("a copied cmd.exe is rejected even when renamed to bash.exe", async () => {
  if (!isWindowsPlatform()) return;
  const dir = await mkdtemp(join(tmpdir(), "pi-bash-bg-cmd-copy-"));
  const renamedPath = join(dir, "bash.exe");
  try {
    await copyFile(
      join(process.env.WINDIR ?? "C:\\Windows", "System32", "cmd.exe"),
      renamedPath,
    );
    assert.throws(
      () => createCustomCandidate(renamedPath),
      /cmd\.exe|not.*Bash|probe/i,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test(
  "discovery ignores stale configured Git Bash paths",
  { skip: posixOnly },
  () => {
    const candidates = discoverBackends({
      findOnPath: () => [],
      probeVersion: () => undefined,
      programFiles: "C:\\missing-program-files",
      programFilesX86: "C:\\missing-program-files-x86",
    });
    assert.equal(candidates.some((value) => value.id === "gitbash"), false);
  },
);

test("custom cmd.exe paths are rejected", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-bash-bg-backend-"));
  const cmdPath = join(dir, "cmd.exe");
  try {
    await writeFile(cmdPath, "not an executable");
    assert.throws(() => createCustomCandidate(cmdPath), /cmd\.exe.*not.*allowed/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test(
  "custom Bash paths are classified as Bash after a real probe",
  { skip: !discoverBackends().some((value) => value.kind === "bash") },
  () => {
    const bashPath = discoverBackends().find((value) => value.kind === "bash")!.path;
    const custom = createCustomCandidate(bashPath);
    assert.equal(custom.id, "custom");
    assert.equal(custom.kind, "bash");
    assert.equal(custom.path, bashPath);
  },
);

test(
  "custom pwsh paths identify as PowerShell 7 after a real probe",
  { skip: !discoverBackends().some((value) => value.id === "pwsh7") },
  () => {
    const pwshPath = discoverBackends().find((value) => value.id === "pwsh7")!.path;
    const custom = createCustomCandidate(pwshPath);
    assert.equal(custom.id, "custom");
    assert.equal(custom.kind, "powershell");
    assert.match(custom.label, /PowerShell 7/i);
  },
);

test("custom unknown executable paths are rejected", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-bash-bg-backend-"));
  const toolPath = join(dir, "tool.exe");
  try {
    await writeFile(toolPath, "test executable placeholder");
    // POSIX rejects non-executable files before classification; make the file
    // executable so the test exercises the "unknown shell" branch everywhere.
    await chmod(toolPath, 0o755);
    assert.throws(() => createCustomCandidate(toolPath), /Bash or PowerShell/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
