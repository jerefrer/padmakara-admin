import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const deployDir = path.resolve(import.meta.dirname, "../../deploy");
const wrapper = path.join(deployDir, "padmakara-install-config");
const realUnit = readFileSync(path.join(deployDir, "padmakara-api.service"), "utf8");

function checkUnit(unit: string): { ok: boolean; stderr: string } {
  const result = spawnSync("bash", [wrapper, "check-unit"], { input: unit, encoding: "utf8" });
  return { ok: result.status === 0, stderr: result.stderr };
}

/** The text between `<<'MARKER'` and the closing MARKER line in setup-server.sh. */
function embedded(marker: string): string {
  const setup = readFileSync(path.join(deployDir, "setup-server.sh"), "utf8");
  const start = setup.indexOf(`<<'${marker}'\n`);
  if (start < 0) throw new Error(`no heredoc ${marker} in setup-server.sh`);
  const bodyStart = setup.indexOf("\n", start) + 1;
  const end = setup.indexOf(`\n${marker}\n`, bodyStart);
  return setup.slice(bodyStart, end + 1);
}

describe("padmakara-install-config check-unit", () => {
  it("should accept the unit shipped in deploy/", () => {
    expect(checkUnit(realUnit).ok).toBe(true);
  });

  it("should refuse a unit that runs as root", () => {
    const result = checkUnit(realUnit.replace("User=padmakara", "User=root"));
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("User must be padmakara");
  });

  it("should refuse a unit with no User", () => {
    expect(checkUnit(realUnit.replace("User=padmakara\n", "")).ok).toBe(false);
  });

  it("should refuse an ExecStart with the full-privilege prefix", () => {
    const result = checkUnit(realUnit.replace("ExecStart=/", "ExecStart=+/"));
    expect(result.ok).toBe(false);
  });

  it("should refuse keys outside the allowlist", () => {
    for (const extra of [
      "ExecStartPre=/bin/sh -c id",
      "AmbientCapabilities=CAP_SYS_ADMIN",
      "PermissionsStartOnly=true",
      "DynamicUser=yes",
    ]) {
      const result = checkUnit(realUnit.replace("[Service]\n", `[Service]\n${extra}\n`));
      expect(result.ok, extra).toBe(false);
    }
  });

  it("should refuse a unit without NoNewPrivileges", () => {
    expect(checkUnit(realUnit.replace("NoNewPrivileges=true", "NoNewPrivileges=false")).ok).toBe(false);
  });

  it("should refuse line continuations", () => {
    const result = checkUnit(realUnit.replace("ExecStart=/home", "ExecStart=/bin/true \\\n/home"));
    expect(result.ok).toBe(false);
  });
});

describe("setup-server.sh embedded copies", () => {
  it("should embed the same install wrapper as deploy/padmakara-install-config", () => {
    expect(embedded("WRAPPER")).toBe(readFileSync(wrapper, "utf8"));
  });

  it("should embed the same backup script as deploy/backup-db.sh", () => {
    expect(embedded("BACKUP")).toBe(readFileSync(path.join(deployDir, "backup-db.sh"), "utf8"));
  });
});
