/**
 * The id a reply or a reaction points at.
 *
 * `@bsv/group-messaging` has no message id. `MessageContent.replyTo` and
 * `Reaction.reference` are opaque strings, defined by whatever application is
 * speaking — the library carries them and never reads them. The only
 * `messageId` in the package belongs to MessageBox and names a relay
 * delivery, not a message, and it is not handed to a subscriber.
 *
 * So the sender mints one and puts it in `extra`, which is the envelope's
 * documented place for application fields. A receiver reads it back out. A
 * message from something that does not do this still gets an id here, so it
 * can be keyed and rendered — it just cannot be referenced by anyone.
 */
import type { MessageContent } from '@bsv/group-messaging'
import { randomChatId } from './randomChatId'

/** Where the id rides inside the envelope. */
const FIELD = 'playgroundMessageId'

export function newMessageId(): string {
  return randomChatId()
}

/** Put an id on an envelope about to be sent, keeping anything already in `extra`. */
export function withMessageId(content: MessageContent, id: string): MessageContent {
  return { ...content, extra: { ...content.extra, [FIELD]: id } }
}

/**
 * The id on a received envelope, or a fresh one when it carries none.
 *
 * A minted fallback is deliberately not stable across devices: nothing else
 * can reference such a message anyway, and inventing a shared id would be a
 * lie about what the sender said.
 */
export function messageIdOf(content: MessageContent): string {
  const carried = content.extra?.[FIELD]
  return typeof carried === 'string' && carried !== '' ? carried : newMessageId()
}
