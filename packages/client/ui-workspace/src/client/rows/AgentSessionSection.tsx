/** Source-owned Agent sessions shown beside Harness Sessions without sharing their ids. */
import { useState } from 'react'
import {
  IconArchiveOutlineRegular, IconEllipsisOutlineRegular, IconPinFillRegular, IconPinOutlineRegular,
  IconUnarchiveOutlineRegular, Menu,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { AgentSessionListFailure, AgentSessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { AgentMeshSessionReference } from '@deepseek-ai/dsh-client-ui-agent-mesh/client'
import type { WorkspaceBrowserProps } from '../contract/slots.ts'
import type { ArchivedFilter } from '../tree.ts'
import css from './Rows.module.css'

/** Match Agent sessions by fields the session store indexes without reading transcript content. */
export function filterAgentSessions(
  sessions: readonly AgentSessionSummary[],
  query?: string,
): readonly AgentSessionSummary[] {
  const normalized = query?.trim().toLocaleLowerCase()
  if (normalized === undefined || normalized === '') return sessions
  return sessions.filter(session => [
    session.agentId,
    session.key,
    session.nativeId,
    session.title ?? '',
    session.cwd ?? '',
    session.model ?? '',
  ].some(value => value.toLocaleLowerCase().includes(normalized)))
}

/** Apply the Workspace browser's archive view and put pinned rows first. */
export function visibleAgentSessions(
  sessions: readonly AgentSessionSummary[],
  archivedFilter: ArchivedFilter,
): readonly AgentSessionSummary[] {
  return sessions
    .filter(session => archivedFilter === 'show'
      || (archivedFilter === 'only' ? session.archived : !session.archived))
    .slice()
    .sort((left, right) => Number(right.pinned) - Number(left.pinned)
      || right.updatedAt.localeCompare(left.updatedAt))
}

/** Put source-owned sessions beside the Workspace with the same recorded working directory. */
export function agentSessionsForWorkspace(
  sessions: readonly AgentSessionSummary[],
  workspacePath: string | undefined,
  registeredPaths: ReadonlySet<string>,
): readonly AgentSessionSummary[] {
  return sessions.filter(session => workspacePath === undefined
    ? session.cwd === undefined || !registeredPaths.has(session.cwd)
    : session.cwd === workspacePath)
}

/** Dispatch a source-session menu action and ignore ids the menu does not declare.
 * @param id - Selected menu item id.
 * @param session - Source-owned session row.
 * @param reference - Exact agent-native session identity.
 * @param actions - Pin and archive operations supplied by the Workspace browser.
 * @param run - Row-owned action runner that reports rejected operations.
 * @returns Nothing.
 */
export function dispatchAgentSessionAction(
  id: string,
  session: AgentSessionSummary,
  reference: AgentMeshSessionReference,
  actions: {
    readonly pin: WorkspaceBrowserProps['setAgentSessionPinned']
    readonly archive: WorkspaceBrowserProps['setAgentSessionArchived']
  },
  run: (action: () => Promise<void>) => void,
): void {
  if (id === 'pin') run(() => actions.pin(reference, !session.pinned))
  else if (id === 'archive') run(() => actions.archive(reference, !session.archived))
}

function AgentSessionRow({
  session,
  onOpen,
  onSetPinned,
  onSetArchived,
  t,
  tree,
}: {
  session: AgentSessionSummary
  onOpen: (reference: AgentMeshSessionReference) => void
  onSetPinned: WorkspaceBrowserProps['setAgentSessionPinned']
  onSetArchived: WorkspaceBrowserProps['setAgentSessionArchived']
  t: WorkspaceBrowserProps['t']
  tree: boolean
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [actionFailed, setActionFailed] = useState(false)
  const reference = { agentId: session.agentId, nativeId: session.nativeId }
  const title = session.title || session.nativeId
  const run = (action: () => Promise<void>): void => {
    setMenuOpen(false)
    setActionFailed(false)
    void Promise.resolve().then(action).catch(() => { setActionFailed(true) })
  }

  return (
    <li role={tree ? 'none' : undefined}>
      <div className={css.agentSessionItem}>
        <button
          type="button"
          role={tree ? 'treeitem' : undefined}
          aria-level={tree ? 2 : undefined}
          aria-label={t('agentSessions.open', { name: title })}
          className={css.agentSessionRow}
          data-row-key={`agent-session:${session.key}`}
          onClick={() => { onOpen(reference) }}
        >
          <span className={css.agentSessionTitle}>{title}</span>
          <span className={css.agentSessionMeta}>
            <span>{t('agentSessions.fromAgent', { agent: session.agentId })}</span>
            {session.cwd !== undefined && <span>{session.cwd}</span>}
            {session.model !== undefined && <span>{session.model}</span>}
            {session.pinned && <span>{t('agentSessions.pinned')}</span>}
            {session.archived && <span>{t('agentSessions.archived')}</span>}
          </span>
        </button>
        <Menu
          open={menuOpen}
          onClose={() => { setMenuOpen(false) }}
          items={[
            {
              id: 'pin',
              label: t(session.pinned ? 'agentSessions.unpin' : 'agentSessions.pin'),
              icon: session.pinned ? <IconPinFillRegular /> : <IconPinOutlineRegular />,
            },
            {
              id: 'archive',
              label: t(session.archived ? 'agentSessions.unarchive' : 'agentSessions.archive'),
              icon: session.archived ? <IconUnarchiveOutlineRegular /> : <IconArchiveOutlineRegular />,
            },
          ]}
          onSelect={(id) => {
            dispatchAgentSessionAction(id, session, reference, { pin: onSetPinned, archive: onSetArchived }, run)
          }}
          portal
          anchor={(
            <button
              type="button"
              className={css.agentSessionActions}
              aria-label={t('agentSessions.actions', { name: title })}
              onClick={() => { setMenuOpen(value => !value) }}
            >
              <IconEllipsisOutlineRegular />
            </button>
          )}
        />
      </div>
      {actionFailed && <p className={css.agentSessionFailure} role="alert">{t('agentSessions.actionFailed')}</p>}
    </li>
  )
}

/** One independently-owned session list, in either the main tree or search results. */
export function AgentSessionSection({
  sessions,
  failures,
  onOpen,
  onSetPinned,
  onSetArchived,
  t,
  tree = false,
  searching = false,
  workspaceTitle,
}: {
  sessions: readonly AgentSessionSummary[]
  failures: readonly AgentSessionListFailure[]
  onOpen: (reference: AgentMeshSessionReference) => void
  onSetPinned: WorkspaceBrowserProps['setAgentSessionPinned']
  onSetArchived: WorkspaceBrowserProps['setAgentSessionArchived']
  t: WorkspaceBrowserProps['t']
  /** Nest the source list under the Workspace browser's existing session tree. */
  tree?: boolean
  /** Explain that search matches source metadata, not transcript content. */
  searching?: boolean
  /** Workspace grouped around this source-owned session list. */
  workspaceTitle?: string
}) {
  if (sessions.length === 0 && failures.length === 0) return null

  return (
    <div
      className={css.agentSessionGroup}
      role={tree ? 'treeitem' : undefined}
      aria-expanded={tree ? true : undefined}
      aria-level={tree ? 1 : undefined}
    >
      <h3 className={css.agentSessionHeading}>{workspaceTitle === undefined
        ? t('agentSessions.heading')
        : t('agentSessions.workspaceHeading', { workspace: workspaceTitle })}</h3>
      {searching && <p className={css.agentSessionHint}>{t('agentSessions.searchHint')}</p>}
      <ul className={css.agentSessionList} role={tree ? 'group' : 'list'}>
        {sessions.map(session => (
          <AgentSessionRow
            key={session.key}
            session={session}
            onOpen={onOpen}
            onSetPinned={onSetPinned}
            onSetArchived={onSetArchived}
            t={t}
            tree={tree}
          />
        ))}
        {failures.map(failure => (
          <li key={failure.agentId} role={tree ? 'none' : undefined}>
            <p className={css.agentSessionFailure} role="status">
              {t('agentSessions.failure', { agent: failure.agentId, message: failure.message })}
            </p>
          </li>
        ))}
      </ul>
    </div>
  )
}
