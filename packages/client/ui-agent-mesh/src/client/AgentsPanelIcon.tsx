/** Decorative occupant for the Agent mesh sidebar entry. */
import { IconUsersOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'

/**
 * Render the agents glyph at the size the sidebar asks for; the sidebar owns
 * the row's button, label, and selected state.
 * @param props - the sidebar's icon share: the requested edge and whether the panel is selected.
 * @returns decorative users icon.
 */
export function AgentsPanelIcon(props: PropsRuntime<'sidebar.panellist'>) {
  return <IconUsersOutlineRegular size={props.size} />
}
