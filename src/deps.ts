import Dockerode from 'dockerode'

export type DepsResult = {
  available: boolean
  docker: boolean
  error?: string
}

export async function check(): Promise<DepsResult> {
  try {
    const docker = new Dockerode()
    await docker.ping()
    return { available: true, docker: true }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return { available: false, docker: false, error: `Docker daemon not available: ${message}` }
  }
}
