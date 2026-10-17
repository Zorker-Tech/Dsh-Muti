import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'

const unusedStandardHook = (): never => {
  throw new Error('The mesh panel fixture does not provide global state')
}

/** Global runtime shares that panel tests do not read. */
export const standardProps: GlobalStandardProps = {
  usePanelInfo: unusedStandardHook,
  useRemoteAccess: unusedStandardHook,
  useSessions: unusedStandardHook,
  useSessionStatus: unusedStandardHook,
  useSessionRetainInfo: unusedStandardHook,
  useSessionAccess: unusedStandardHook,
  useWorkspaces: unusedStandardHook,
  useWorkspaceAccess: unusedStandardHook,
  useResource: unusedStandardHook,
}
