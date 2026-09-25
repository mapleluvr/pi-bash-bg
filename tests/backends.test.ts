import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCustomCandidate,
  discoverBackends,
  resolveBackend,
  type BackendCandidate,
} from "../src/backends.ts";

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
    assert.ok(["pwsh7", "gitbash", "powershell51", "custom"].includes(candidate.id));
  }
});
test("auto chooses PowerShell 7 before Git Bash and PowerShell 5.1", () => {
  const selected = resolveBackend("auto", [
    candidate("powershell51", "powershell"),
    candidate("gitbash", "bash"),
    candidate("pwsh7", "powershell"),
  ]);
  assert.equal(selected.id, "pwsh7");
});

test("auto falls back to Git Bash before PowerShell 5.1", () => {
  const selected = resolveBackend("auto", [
    candidate("powershell51", "powershell"),
    candidate("gitbash", "bash"),
  ]);
  assert.equal(selected.id, "gitbash");
});

test("auto chooses PowerShell 5.1 when it is the only supported backend", () => {
  const selected = resolveBackend("auto", [candidate("powershell51", "powershell")]);
  assert.equal(selected.id, "powershell51");
});

test("resolver rejects an injected relative executable candidate", () => {
  assert.throws(
    () => resolveBackend("gitbash", [candidate("gitbash", "bash", "bash.exe")]),
    /absolute|invalid|available/i,
  );
});
test("resolver rejects an injected missing absolute executable candidate", () => {
  assert.throws(
    () => resolveBackend("gitbash", [candidate("gitbash", "bash", "C:\\missing\\bash.exe")]),
    /absolute|missing|available|executable/i,
  );
});
test("auto fails with searched backend details instead of falling back to cmd", () => {
  assert.throws(
    () => resolveBackend("auto", []),
    /No shell backend available.*PowerShell 7.*Git Bash.*PowerShell 5\.1/i,
  );
});

test("explicit backend selection does not use a different discovered backend", () => {
  const selected = resolveBackend("gitbash", [
    candidate("pwsh7", "powershell"),
    candidate("gitbash", "bash"),
  ]);
  assert.equal(selected.id, "gitbash");
});

test("unprobeable pwsh.exe is skipped so auto can use the next backend", async () => {
  const candidates = discoverBackends({
    findOnPath: (executable) => (executable === "pwsh.exe" ? [process.execPath] : []),
    probeVersion: () => undefined,
    programFiles: "",
    programFilesX86: "",
  });
  assert.deepEqual(candidates, []);
});

test("discovery ignores unprobeable Bash and Windows PowerShell candidates", () => {
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
});
test("a copied cmd.exe is rejected even when renamed to bash.exe", async () => {
  if (process.platform !== "win32") return;
  const dir = await mkdtemp(join(tmpdir(), "pi-bash-bg-cmd-copy-"));
  const renamedPath = join(dir, "bash.exe");
  try {
    await copyFile(join(process.env.WINDIR ?? "C:\\Windows", "System32", "cmd.exe"), renamedPath);
    assert.throws(
      () => createCustomCandidate(renamedPath),
      /cmd\.exe|not.*Bash|probe/i,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("discovery ignores stale configured Git Bash paths", () => {
  const candidates = discoverBackends({
    findOnPath: () => [],
    probeVersion: () => undefined,
    programFiles: "C:\\missing-program-files",
    programFilesX86: "C:\\missing-program-files-x86",
  });
  assert.equal(candidates.some((candidate) => candidate.id === "gitbash"), false);
});
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
  "custom bash paths are classified as Bash after a real probe",
  { skip: !discoverBackends().some((candidate) => candidate.id === "gitbash") },
  () => {
    const bashPath = discoverBackends().find((candidate) => candidate.id === "gitbash")!.path;
    const custom = createCustomCandidate(bashPath);
    assert.equal(custom.id, "custom");
    assert.equal(custom.kind, "bash");
    assert.equal(custom.path, bashPath);
  },
);

test(
  "custom pwsh paths identify as PowerShell 7 after a real probe",
  { skip: !discoverBackends().some((candidate) => candidate.id === "pwsh7") },
  () => {
    const pwshPath = discoverBackends().find((candidate) => candidate.id === "pwsh7")!.path;
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
    assert.throws(() => createCustomCandidate(toolPath), /Bash or PowerShell/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
