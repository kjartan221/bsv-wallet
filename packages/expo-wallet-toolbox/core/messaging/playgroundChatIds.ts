/**
 * Which chat an invitation belongs to.
 *
 * `chatId` is this device's own name for a chat and never crosses the wire;
 * `chatName` is the only thing that does. So the inviter decides the id when it
 * starts a chat, and the invitee mints one of its own when a Welcome arrives —
 * the two sides are under no obligation to agree, and deliberately do not try.
 *
 * In memory, like the template's `MemoryShelf` and for the same reason: the
 * mapping only has to outlive an invitation in flight. A restart loses invites
 * that were sent and not yet answered, which for a playground is a dropped test
 * rather than lost data. A product would make this a table.
 */
import { randomChatId } from './randomChatId'

export interface PlaygroundChat {
  chatId: string
  /** What the other side is told the chat is called. */
  name: string
}

export class PlaygroundChatIds {
  readonly #byInvite = new Map<string, PlaygroundChat>()

  /** Record the chat an invitation was sent for, before it is sent. */
  remember(inviteId: string, chat: PlaygroundChat): void {
    this.#byInvite.set(inviteId, chat)
  }

  /** Inviter side: which chat this answer belongs to. */
  forAnswer(inviteId: string): string {
    const known = this.#byInvite.get(inviteId)
    if (known !== undefined) return known.chatId
    // An answer to an invitation this process did not send — a restart, most
    // likely. A fresh chat is better than throwing inside a detached handler.
    const made = { chatId: randomChatId(), name: 'Chat' }
    this.#byInvite.set(inviteId, made)
    return made.chatId
  }

  /** Inviter side: the name carried by the request and the Welcome. */
  nameFor(inviteId: string): string | undefined {
    return this.#byInvite.get(inviteId)?.name
  }

  /** Invitee side: this device's own id for a chat it is being added to. */
  forWelcome(_chatName: string | undefined): string {
    return randomChatId()
  }
}
