import { describe, test, expect, mock, beforeEach } from "bun:test"
import { ensureImage, buildImage } from "../src/image"

// Create mock dockerode instance
function createMockDocker(images: unknown[] = []) {
  return {
    listImages: mock(() => Promise.resolve(images)),
    getImage: mock(() => ({})),
    buildImage: mock(() => Promise.resolve({})),
  } as any
}

describe("ensureImage", () => {
  test("returns image tag when image already exists", async () => {
    const docker = createMockDocker([
      { RepoTags: ["opencode-sandbox:local"], Id: "sha256:abc123" },
    ])

    const result = await ensureImage(docker)

    expect(result).toBe("opencode-sandbox:local")
    expect(docker.listImages).toHaveBeenCalledTimes(1)
    expect(docker.listImages).toHaveBeenCalledWith({
      filters: { reference: ["opencode-sandbox:local"] },
    })
  })

  test("calls buildImage when image does not exist", async () => {
    // First call: no images (triggers build). Second call: image exists (post-build verify).
    let callCount = 0
    const docker = {
      listImages: mock(() => {
        callCount++
        if (callCount === 1) return Promise.resolve([])
        return Promise.resolve([
          { RepoTags: ["opencode-sandbox:local"], Id: "sha256:def456" },
        ])
      }),
    } as any

    // Mock Bun.spawn so we don't actually run docker build
    const originalSpawn = Bun.spawn
    // @ts-expect-error - overriding Bun.spawn for test
    Bun.spawn = mock(() => ({
      exited: Promise.resolve(0),
      stdout: new ReadableStream(),
      stderr: new ReadableStream(),
    }))

    try {
      const result = await ensureImage(docker)
      expect(result).toBe("opencode-sandbox:local")
      // listImages called twice: once in ensureImage, once in buildImage verify
      expect(docker.listImages).toHaveBeenCalledTimes(2)
    } finally {
      // @ts-expect-error - restoring Bun.spawn
      Bun.spawn = originalSpawn
    }
  })
})

describe("buildImage", () => {
  test("throws on build failure", async () => {
    const docker = createMockDocker()

    const originalSpawn = Bun.spawn
    // @ts-expect-error - overriding Bun.spawn for test
    Bun.spawn = mock(() => ({
      exited: Promise.resolve(1),
      stdout: new ReadableStream(),
      stderr: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("build error"))
          controller.close()
        },
      }),
    }))

    try {
      await expect(buildImage(docker, "/fake/Dockerfile")).rejects.toThrow(
        "Failed to build sandbox image",
      )
    } finally {
      // @ts-expect-error - restoring Bun.spawn
      Bun.spawn = originalSpawn
    }
  })

  test("throws when image not found after successful build", async () => {
    const docker = createMockDocker([]) // listImages always returns empty

    const originalSpawn = Bun.spawn
    // @ts-expect-error - overriding Bun.spawn for test
    Bun.spawn = mock(() => ({
      exited: Promise.resolve(0),
      stdout: new ReadableStream(),
      stderr: new ReadableStream(),
    }))

    try {
      await expect(buildImage(docker, "/fake/Dockerfile")).rejects.toThrow(
        "Image build succeeded but image not found after build",
      )
    } finally {
      // @ts-expect-error - restoring Bun.spawn
      Bun.spawn = originalSpawn
    }
  })

  test("returns tag on successful build", async () => {
    const docker = createMockDocker([
      { RepoTags: ["opencode-sandbox:local"], Id: "sha256:abc" },
    ])

    const originalSpawn = Bun.spawn
    // @ts-expect-error - overriding Bun.spawn for test
    Bun.spawn = mock(() => ({
      exited: Promise.resolve(0),
      stdout: new ReadableStream(),
      stderr: new ReadableStream(),
    }))

    try {
      const result = await buildImage(docker, "/fake/Dockerfile")
      expect(result).toBe("opencode-sandbox:local")
    } finally {
      // @ts-expect-error - restoring Bun.spawn
      Bun.spawn = originalSpawn
    }
  })
})
