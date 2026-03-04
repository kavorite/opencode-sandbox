import { describe, test, expect } from "bun:test"
import { mapChanges, snapshotKey } from "../src/diff"
import type { ContainerChange } from "../src/diff"

const PROJECT = "/home/user/project"
const HOME = "/home/user"

describe("mapChanges", () => {
  test("added file outside project → FsMutation with syscall creat", () => {
    const changes: ContainerChange[] = [{ Kind: 1, Path: "/home/user/.cache/bar" }]
    const result = mapChanges(changes, PROJECT, HOME)
    expect(result.mutations).toHaveLength(1)
    expect(result.mutations[0]).toEqual({
      kind: "fs_mutation",
      syscall: "creat",
      path: "/home/user/.cache/bar",
      result: 0,
    })
    expect(result.files).toHaveLength(0)
    expect(result.writes).toHaveLength(0)
  })

  test("modified file outside project → FsMutation(rename) + FileWrite", () => {
    const changes: ContainerChange[] = [{ Kind: 0, Path: "/home/user/.bashrc" }]
    const result = mapChanges(changes, PROJECT, HOME)
    expect(result.mutations).toHaveLength(1)
    expect(result.mutations[0]).toEqual({
      kind: "fs_mutation",
      syscall: "rename",
      path: "/home/user/.bashrc",
      result: 0,
    })
    expect(result.writes).toHaveLength(1)
    expect(result.writes[0]).toEqual({
      kind: "file_write",
      syscall: "write",
      fd: -1,
      bytes: 0,
      result: 0,
    })
  })

  test("deleted file outside project → FsMutation with syscall unlink", () => {
    const changes: ContainerChange[] = [{ Kind: 2, Path: "/home/user/.old_config" }]
    const result = mapChanges(changes, PROJECT, HOME)
    expect(result.mutations).toHaveLength(1)
    expect(result.mutations[0]).toEqual({
      kind: "fs_mutation",
      syscall: "unlink",
      path: "/home/user/.old_config",
      result: 0,
    })
  })

  test("changes under project path → filtered out", () => {
    const changes: ContainerChange[] = [
      { Kind: 1, Path: "/home/user/project/foo.ts" },
      { Kind: 0, Path: "/home/user/project/bar.ts" },
      { Kind: 2, Path: "/home/user/project/baz.ts" },
    ]
    const result = mapChanges(changes, PROJECT, HOME)
    expect(result.mutations).toHaveLength(0)
    expect(result.writes).toHaveLength(0)
  })

  test("changes under /tmp → filtered out", () => {
    const changes: ContainerChange[] = [
      { Kind: 1, Path: "/tmp/some-file" },
      { Kind: 0, Path: "/proc/self/maps" },
      { Kind: 1, Path: "/sys/fs/cgroup/something" },
      { Kind: 2, Path: "/dev/null" },
      { Kind: 1, Path: "/run/lock/test" },
    ]
    const result = mapChanges(changes, PROJECT, HOME)
    expect(result.mutations).toHaveLength(0)
    expect(result.writes).toHaveLength(0)
  })

  test("added directory (path ending in /) → FsMutation with syscall mkdir", () => {
    const changes: ContainerChange[] = [{ Kind: 1, Path: "/home/user/.local/share/newdir/" }]
    const result = mapChanges(changes, PROJECT, HOME)
    expect(result.mutations).toHaveLength(1)
    expect(result.mutations[0]).toEqual({
      kind: "fs_mutation",
      syscall: "mkdir",
      path: "/home/user/.local/share/newdir/",
      result: 0,
    })
  })

  test("deleted directory (path ending in /) → FsMutation with syscall rmdir", () => {
    const changes: ContainerChange[] = [{ Kind: 2, Path: "/home/user/.local/share/olddir/" }]
    const result = mapChanges(changes, PROJECT, HOME)
    expect(result.mutations).toHaveLength(1)
    expect(result.mutations[0]).toEqual({
      kind: "fs_mutation",
      syscall: "rmdir",
      path: "/home/user/.local/share/olddir/",
      result: 0,
    })
  })

  test("multiple changes, mix of in-project and out-of-project → only out-of-project returned", () => {
    const changes: ContainerChange[] = [
      { Kind: 1, Path: "/home/user/project/foo.ts" },
      { Kind: 1, Path: "/home/user/.cache/bar" },
      { Kind: 0, Path: "/home/user/project/src/index.ts" },
      { Kind: 2, Path: "/home/user/.config/old" },
      { Kind: 1, Path: "/tmp/throwaway" },
    ]
    const result = mapChanges(changes, PROJECT, HOME)
    expect(result.mutations).toHaveLength(2)
    expect(result.mutations[0]).toEqual({
      kind: "fs_mutation",
      syscall: "creat",
      path: "/home/user/.cache/bar",
      result: 0,
    })
    expect(result.mutations[1]).toEqual({
      kind: "fs_mutation",
      syscall: "unlink",
      path: "/home/user/.config/old",
      result: 0,
    })
  })

  test("baseline diffing: changes in baseline are excluded", () => {
    // Simulate GPU runtime injection in baseline
    const baselineChanges: ContainerChange[] = [
      { Kind: 1, Path: "/lib/firmware/nvidia" },
      { Kind: 1, Path: "/usr/lib64/libnvidia-ml.so.1" },
      { Kind: 0, Path: "/etc/ld.so.cache" },
      { Kind: 1, Path: "/var/cache/ldconfig/aux-cache" },
    ]
    const baseline = new Set(baselineChanges.map(snapshotKey))

    // After command: baseline artifacts + one real user write
    const afterCommand: ContainerChange[] = [
      ...baselineChanges,
      { Kind: 1, Path: "/home/user/.cache/new-file" },
    ]

    const result = mapChanges(afterCommand, PROJECT, HOME, [], undefined, baseline)
    // Only the new file should be reported, not the baseline artifacts
    expect(result.mutations).toHaveLength(1)
    expect(result.mutations[0]?.path).toBe("/home/user/.cache/new-file")
  })

  test("baseline diffing: same path with different Kind is NOT excluded", () => {
    // File was added in baseline (Kind=1), now modified (Kind=0)
    const baseline = new Set(["1:/home/user/.cache/somefile"])
    const changes: ContainerChange[] = [
      { Kind: 0, Path: "/home/user/.cache/somefile" },
    ]
    const result = mapChanges(changes, PROJECT, HOME, [], undefined, baseline)
    expect(result.mutations).toHaveLength(1)
    expect(result.mutations[0]?.syscall).toBe("rename")
  })

  test("baseline diffing: empty baseline behaves like no baseline", () => {
    const changes: ContainerChange[] = [
      { Kind: 1, Path: "/home/user/.cache/bar" },
    ]
    const result = mapChanges(changes, PROJECT, HOME, [], undefined, new Set())
    expect(result.mutations).toHaveLength(1)
  })
})
