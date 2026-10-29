/**
 * Message ids, which the library does not have.
 *
 * `replyTo` and a reaction's `reference` are opaque strings the application
 * defines; the library carries them and never reads them. So the sender mints
 * one into `extra` and the receiver reads it back, and a reply points at
 * something real rather than at a guess.
 */
import { messageIdOf, newMessageId, withMessageId } from '../../core/messaging/messageIds'

describe('message ids', () => {
  it('round-trips through the envelope', () => {
    const id = newMessageId()

    expect(messageIdOf(withMessageId({ v: 1, type: 'text', body: 'hi' }, id))).toBe(id)
  })

  it('does not disturb what is already in extra', () => {
    const content = withMessageId({ v: 1, type: 'text', body: 'hi', extra: { keep: 'this' } }, 'm1')

    expect(content.extra?.keep).toBe('this')
    expect(messageIdOf(content)).toBe('m1')
  })

  it('leaves the rest of the envelope alone', () => {
    const content = withMessageId({ v: 1, type: 'reply', body: 'yes', replyTo: 'm1' }, 'm2')

    expect(content.type).toBe('reply')
    expect(content.replyTo).toBe('m1')
    expect(content.body).toBe('yes')
  })

  it('gives an id to a message that arrived without one', () => {
    // Another client, or an older build of this one. It still has to be keyed
    // and drawn; it simply cannot be referenced.
    const id = messageIdOf({ v: 1, type: 'text', body: 'from elsewhere' })

    expect(typeof id).toBe('string')
    expect(id.length).toBeGreaterThan(0)
  })

  it('ignores an id that is not a string, rather than trusting it', () => {
    const id = messageIdOf({ v: 1, type: 'text', body: 'x', extra: { playgroundMessageId: 42 } })

    expect(typeof id).toBe('string')
  })

  it('mints different ids', () => {
    expect(newMessageId()).not.toBe(newMessageId())
  })
})
