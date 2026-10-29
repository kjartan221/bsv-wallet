/**
 * A late subscriber still learns what the socket is doing.
 *
 * `MessageBoxTransport.onLiveStatus` only adds the handler — it replays
 * nothing — and the transport drops a status identical to the last one it
 * sent. So the socket connecting, authenticating and joining its room during
 * `GroupMessagingClient.create()` is announced to nobody, and a host that
 * subscribes after `create()` resolves waits for a change that never comes.
 *
 * On device that read as "Connecting to the relay" forever, under a socket
 * the relay logs showed as subscribed and listening.
 *
 * So the playground subscribes when it builds the transport, before `create()`,
 * and hands out a subscribe that replays the latest status first.
 */
const mockEmit: { send?: (status: unknown) => void } = {}

jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: async () => ({
    execAsync: async () => undefined,
    runAsync: async () => undefined,
    getAllAsync: async () => []
  })
}))
jest.mock('@bsv/message-box-client', () => ({ MessageBoxClient: class {} }))
jest.mock('../../core/pay/rails/handle', () => ({
  bindMessageBoxNetwork: (client: unknown) => client,
  MESSAGE_BOX_URL_KEY: 'message_box_url'
}))

jest.mock('@bsv/group-messaging', () => ({
  // The real transport opens its socket as the library starts it, which is
  // during create(); this one just emits on cue at the same point.
  MessageBoxTransport: class {
    handlers = new Set()
    constructor() {
      mockEmit.send = status => this.handlers.forEach((h: any) => h(status))
    }
    onLiveStatus(handler: unknown) {
      this.handlers.add(handler)
      return () => this.handlers.delete(handler)
    }
  },
  TransportService: class {},
  GroupMessagingClient: {
    create: async () => {
      mockEmit.send?.({ phase: 'subscribed', source: 'live' })
      return { identityKey: '02ab' }
    }
  }
}))

import { openPlaygroundClient } from '../../core/messaging/playground'

const base = {
  wallet: { getPublicKey: async () => ({ publicKey: '02' }) },
  adminOriginator: 'admin.test',
  chain: 'test' as const,
  host: 'https://relay.example.test'
}

beforeEach(() => {
  mockEmit.send = undefined
})

describe('the playground live status', () => {
  it('replays the status the socket reached during create()', async () => {
    const opened = await openPlaygroundClient(base)

    const seen: unknown[] = []
    opened.onLiveStatus(s => seen.push(s))

    expect(seen).toEqual([{ phase: 'subscribed', source: 'live' }])
  })

  it('keeps forwarding changes after the replay', async () => {
    const opened = await openPlaygroundClient(base)

    const seen: unknown[] = []
    opened.onLiveStatus(s => seen.push(s))
    mockEmit.send?.({ phase: 'reconnecting', source: 'live' })

    expect(seen).toEqual([
      { phase: 'subscribed', source: 'live' },
      { phase: 'reconnecting', source: 'live' }
    ])
  })

  it('stops forwarding once unsubscribed', async () => {
    const opened = await openPlaygroundClient(base)

    const seen: unknown[] = []
    const stop = opened.onLiveStatus(s => seen.push(s))
    stop()
    mockEmit.send?.({ phase: 'closed', source: 'live' })

    expect(seen).toEqual([{ phase: 'subscribed', source: 'live' }])
  })

  it('replays to each subscriber independently', async () => {
    const opened = await openPlaygroundClient(base)

    const first: unknown[] = []
    const second: unknown[] = []
    opened.onLiveStatus(s => first.push(s))
    opened.onLiveStatus(s => second.push(s))
    mockEmit.send?.({ phase: 'closed', source: 'live' })

    const expected = [
      { phase: 'subscribed', source: 'live' },
      { phase: 'closed', source: 'live' }
    ]
    expect(first).toEqual(expected)
    expect(second).toEqual(expected)
  })
})
