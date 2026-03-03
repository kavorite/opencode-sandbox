import path from "path"
import Dockerode from "dockerode"

const IMAGE_NAME = "opencode-sandbox"
const IMAGE_TAG = "local"
const FULL_TAG = `${IMAGE_NAME}:${IMAGE_TAG}`
const LABEL_KEY = "opencode-sandbox"

/**
 * Check if the sandbox image exists; build it if not. Returns the full image tag.
 */
export async function ensureImage(docker: Dockerode): Promise<string> {
  const images = await docker.listImages({
    filters: { reference: [FULL_TAG] },
  })
  if (images.length > 0) {
    return FULL_TAG
  }
  const dockerfilePath = path.join(import.meta.dir, "..", "Dockerfile")
  return buildImage(docker, dockerfilePath)
}

/**
 * Build the sandbox image from the given Dockerfile path.
 * Uses `docker build` CLI via Bun.spawn for simplicity (avoids dockerode tar stream complexity).
 * The `docker` parameter is accepted for interface consistency and post-build verification.
 * Returns the full image tag.
 */
export async function buildImage(
  docker: Dockerode,
  dockerfilePath: string,
): Promise<string> {
  const context = path.dirname(dockerfilePath)
  const proc = Bun.spawn(
    [
      "docker",
      "build",
      "-t",
      FULL_TAG,
      "--label",
      `${LABEL_KEY}=true`,
      "-f",
      dockerfilePath,
      context,
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  )

  const exitCode = await proc.exited
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text()
    throw new Error(
      `Failed to build sandbox image (exit ${exitCode}): ${stderr}`,
    )
  }

  // Verify the image was created
  const images = await docker.listImages({
    filters: { reference: [FULL_TAG] },
  })
  if (images.length === 0) {
    throw new Error("Image build succeeded but image not found after build")
  }

  return FULL_TAG
}
