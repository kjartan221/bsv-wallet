/**
 * The playground's relay host is its own setting.
 *
 * The point of these: `MESSAGE_BOX_URL_KEY` routes payments, so the playground
 * having its own key is not tidiness — writing one must not move the other.
 */
import AsyncStorage from '@react-native-async-storage/async-storage'
import { MESSAGE_BOX_URL_KEY } from '../../core/pay/rails/handle'
import {
  DEFAULT_PLAYGROUND_MESSAGE_BOX_URL,
  MESSAGING_PLAYGROUND_HOST_KEY,
  readPlaygroundHost,
  writePlaygroundHost
} from '../../core/messaging/playground'

beforeEach(async () => {
  await AsyncStorage.clear()
})

describe('the playground relay host', () => {
  it('defaults to the relay that serves WebSockets', async () => {
    expect(await readPlaygroundHost(0)).toBe(DEFAULT_PLAYGROUND_MESSAGE_BOX_URL)
    expect(DEFAULT_PLAYGROUND_MESSAGE_BOX_URL).toContain('message-box-us-1')
  })

  it('remembers a chosen relay, without its trailing slash', async () => {
    await writePlaygroundHost('https://relay.example.com/', 0)
    expect(await readPlaygroundHost(0)).toBe('https://relay.example.com')
  })

  it('falls back to the default once the choice is cleared', async () => {
    await writePlaygroundHost('https://relay.example.com', 0)
    await writePlaygroundHost('', 0)
    expect(await readPlaygroundHost(0)).toBe(DEFAULT_PLAYGROUND_MESSAGE_BOX_URL)
  })

  it('refuses something that is not a URL, and an origin that is not allowed', async () => {
    await expect(writePlaygroundHost('not a url', 0)).rejects.toThrow(/not a URL/i)
    await expect(writePlaygroundHost('http://insecure.example.com', 0)).rejects.toThrow(/not allowed/i)
    expect(await readPlaygroundHost(0)).toBe(DEFAULT_PLAYGROUND_MESSAGE_BOX_URL)
  })

  it('does not share a key with the payment rail', async () => {
    expect(MESSAGING_PLAYGROUND_HOST_KEY).not.toBe(MESSAGE_BOX_URL_KEY)
    // Nor as a substring: a grep for the payment key must not find this one.
    expect(MESSAGING_PLAYGROUND_HOST_KEY).not.toContain(MESSAGE_BOX_URL_KEY)

    await writePlaygroundHost('https://relay.example.com', 0)

    // The payment host is untouched: nothing was written under its key.
    const written = await AsyncStorage.getAllKeys()
    expect(written.some(k => k.includes(MESSAGE_BOX_URL_KEY))).toBe(false)
  })

  it("keeps one profile's relay out of another's", async () => {
    await writePlaygroundHost('https://one.example.com', 0)
    await writePlaygroundHost('https://two.example.com', 1)

    expect(await readPlaygroundHost(0)).toBe('https://one.example.com')
    expect(await readPlaygroundHost(1)).toBe('https://two.example.com')
  })
})
