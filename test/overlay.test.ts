import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import os from "os";
import fs from "fs/promises";
import path from "path";
import { run } from "../src/sandbox";
import * as deps from "../src/deps";

const linux = os.platform() === "linux";

async function hasBwrap(): Promise<boolean> {
  try {
    const proc = Bun.spawn(
      ["bwrap", "--ro-bind", "/", "/", "--unshare-user", "true"],
      {
        stdio: ["ignore", "ignore", "ignore"],
      },
    );
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

async function hasStrace(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["strace", "-V"], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

async function hasOverlay(): Promise<boolean> {
  try {
    const proc = Bun.spawn(
      [
        "bwrap",
        "--ro-bind",
        "/",
        "/",
        "--overlay-src",
        "/tmp",
        "--tmp-overlay",
        "/tmp",
        "true",
      ],
      { stdio: ["ignore", "ignore", "ignore"] },
    );
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

const available = linux && (await hasBwrap()) && (await hasStrace());
const overlay = available && (await hasOverlay());

const cfg = {
  timeout: 10000,
  network: { mode: "block" as const, allow: [] },
  filesystem: { inherit_permissions: true, allow_write: [], deny_read: [] },
  auto_allow_clean: true,
  home_readable: true,
  verbose: false,
};

// --- Test 3: deps.overlay detected correctly ---

describe("deps.overlay detection", () => {
  test("check() returns overlay as boolean", async () => {
    deps.reset();
    const result = await deps.check();
    expect(result).toHaveProperty("overlay");
    expect(typeof result.overlay).toBe("boolean");
  });
});

// --- Tests 1 & 2: COW overlay isolation ---

describe.skipIf(!overlay)("COW overlay isolation", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.homedir(), "oc-overlay-test-"));
  });

  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  test("file write isolated — succeeds in sandbox, absent on host", async () => {
    const target = path.join(dir, "cow-test.txt");
    const result = await run(`echo "hello overlay" > "${target}"`, dir, cfg, {
      observe: false,
      overlay: true,
    });

    expect(result.timedOut).toBe(false);
    const exists = await Bun.file(target).exists();
    expect(exists).toBe(false);
  });

  test("git commit in overlay — real HEAD unchanged", async () => {
    // Init git repo with initial commit
    await Bun.spawn(["git", "init"], {
      cwd: dir,
      stdio: ["ignore", "ignore", "ignore"],
    }).exited;
    await Bun.spawn(
      [
        "git",
        "-c",
        "user.email=t@t.com",
        "-c",
        "user.name=T",
        "commit",
        "--allow-empty",
        "-m",
        "init",
      ],
      { cwd: dir, stdio: ["ignore", "ignore", "ignore"] },
    ).exited;

    // Record original HEAD
    const proc = Bun.spawn(["git", "rev-parse", "HEAD"], {
      cwd: dir,
      stdout: "pipe",
    });
    const head = (await new Response(proc.stdout).text()).trim();
    await proc.exited;

    // Run git commit inside sandbox with overlay
    const result = await run(
      'touch newfile.txt && git add -A && git -c user.email=t@t.com -c user.name=T commit -m "overlay"',
      dir,
      cfg,
      { observe: false, overlay: true },
    );

    expect(result.timedOut).toBe(false);

    // Verify real HEAD unchanged
    const check = Bun.spawn(["git", "rev-parse", "HEAD"], {
      cwd: dir,
      stdout: "pipe",
    });
    const current = (await new Response(check.stdout).text()).trim();
    await check.exited;
    expect(current).toBe(head);

    // Verify newfile.txt absent on host
    const exists = await Bun.file(path.join(dir, "newfile.txt")).exists();
    expect(exists).toBe(false);
  });

  test("overlay mutations filtered — no relative bwrap internal paths", async () => {
    const result = await run(
      "mkdir -p testdir && touch testdir/file.txt",
      dir,
      cfg,
      { observe: false, overlay: true },
    );

    expect(result.timedOut).toBe(false);
    for (const m of result.mutations) {
      expect(m.path.startsWith("/")).toBe(true);
    }
  });
});

// --- Test 4: Fallback when overlay is false ---

describe.skipIf(!available)("overlay fallback (overlay=false)", () => {
  test("command executes without overlay", async () => {
    const result = await run("echo fallback", "/tmp", cfg, {
      observe: false,
      overlay: false,
    });

    expect(result.timedOut).toBe(false);
    expect(result.duration).toBeGreaterThan(0);
  });

  test("ro-bind path used when overlay disabled", async () => {
    const dir = await fs.mkdtemp(path.join(os.homedir(), "oc-overlay-fb-"));
    try {
      const target = path.join(dir, "should-not-exist.txt");
      // With overlay=false and home_readable=true, $HOME is ro-bind — write fails inside sandbox
      const result = await run(
        `echo "test" > "${target}" 2>/dev/null || true`,
        dir,
        cfg,
        { observe: false, overlay: false },
      );

      expect(result.timedOut).toBe(false);
      // File should not exist on host regardless
      const exists = await Bun.file(target).exists();
      expect(exists).toBe(false);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
