import type { MeshLaunchShell } from './types.ts'

/**
 * Select the shell dialect used by the DSH Host platform.
 * @param platformName - Platform reported by Node.js.
 * @returns The shell dialect used to quote a native-session command.
 */
export function nativeLaunchShell(platformName: NodeJS.Platform): MeshLaunchShell {
  return platformName === 'win32' ? 'powershell' : 'posix'
}
