/**
 * A local chat id.
 *
 * Local-only: `chatId` never crosses the wire, so this needs to be unique on
 * this device and nothing more. `crypto.getRandomValues` is the same source the
 * library uses for its own ids and is polyfilled in this app already.
 */
export function randomChatId(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
}
