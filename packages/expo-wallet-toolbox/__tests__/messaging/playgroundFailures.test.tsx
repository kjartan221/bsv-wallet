/**
 * A failed exchange has to reach the screen.
 *
 * `ManagedInvitations` reports failures through a callback. Collecting them
 * into a plain array and handing that array to the hook's state looks like it
 * works and cannot: pushing mutates a reference React already holds, so no
 * state changes, no memo recomputes, and the "Could not finish" section stays
 * empty forever. On device that made a failed admit indistinguishable from an
 * invitation still in flight — which is exactly the thing that section exists
 * to tell apart.
 */
const reporters: ((failure: unknown) => void)[] = []
const settled: (() => void)[] = []

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
  MessageBoxTransport: class {
    onLiveStatus() {
      return () => undefined
    }
  },
  TransportService: class {},
  GroupMessagingClient: {
    create: async () => ({ identityKey: '02ab', on: () => () => {}, close: async () => {} })
  }
}))

// The real one wires itself to the client; here it only has to hand back the
// failure reporter the hook gave it.
jest.mock('../../core/messaging/managedInvitations', () => ({
  ManagedInvitations: class {
    constructor(
      _client: unknown,
      _shelf: unknown,
      _chatIds: unknown,
      onFailure: (failure: unknown) => void,
      onSettled: () => void
    ) {
      reporters.push(onFailure)
      settled.push(onSettled)
    }
    start() {
      return () => undefined
    }
  },
  MemoryShelf: class {}
}))

import React from 'react'
import { renderHook, waitFor, act } from '@testing-library/react-native'
import { useMessagingPlayground, resetPlaygroundClient } from '../../ui/hooks/useMessagingPlayground'

const wallet = { getPublicKey: async () => ({ publicKey: '02' }) }

beforeEach(() => {
  reporters.length = 0
  settled.length = 0
  resetPlaygroundClient()
})

describe('failures reaching the screen', () => {
  it('reports a failure that happens after the client is open', async () => {
    const { result } = renderHook(() => useMessagingPlayground(wallet, 'admin.test', 'test'))
    await waitFor(() => expect(result.current.client).toBeDefined())
    expect(result.current.failures).toEqual([])

    // Held by reference: if the hook mutates this array instead of replacing
    // it, the contents below would match while React re-rendered nothing and
    // the screen stayed empty. The identity check is the real assertion.
    const before = result.current.failures

    const failure = { stage: 'admit', chatId: 'abc', peer: '02cc', reason: 'HMAC unsupported' }
    await act(async () => {
      reporters.forEach(report => report(failure))
    })

    await waitFor(() => expect(result.current.failures).toEqual([failure]))
    expect(result.current.failures).not.toBe(before)
  })

  it('keeps earlier failures when another arrives', async () => {
    const { result } = renderHook(() => useMessagingPlayground(wallet, 'admin.test', 'test'))
    await waitFor(() => expect(result.current.client).toBeDefined())

    const first = { stage: 'admit', chatId: 'a', peer: '02aa', reason: 'one' }
    const second = { stage: 'join', chatId: 'b', peer: '02bb', reason: 'two' }
    await act(async () => {
      reporters.forEach(report => report(first))
    })
    await act(async () => {
      reporters.forEach(report => report(second))
    })

    await waitFor(() => expect(result.current.failures).toEqual([first, second]))
    expect(result.current.failures).toHaveLength(2)
  })

  it('hands a new subscriber the failures it missed', async () => {
    const first = renderHook(() => useMessagingPlayground(wallet, 'admin.test', 'test'))
    await waitFor(() => expect(first.result.current.client).toBeDefined())

    const failure = { stage: 'admit', chatId: 'abc', peer: '02cc', reason: 'happened earlier' }
    await act(async () => {
      reporters.forEach(report => report(failure))
    })
    first.unmount()

    // The client is shared and outlives any one screen, so a screen opened
    // afterwards still has to see what went wrong while it was closed.
    const second = renderHook(() => useMessagingPlayground(wallet, 'admin.test', 'test'))
    await waitFor(() => expect(second.result.current.failures).toEqual([failure]))

    // And a failure after the remount still lands, so the subscription was
    // re-established rather than just replayed once.
    const later = { stage: 'join', chatId: 'xyz', peer: '02dd', reason: 'after remount' }
    const before = second.result.current.failures
    await act(async () => {
      reporters.forEach(report => report(later))
    })
    await waitFor(() => expect(second.result.current.failures).toHaveLength(2))
    expect(second.result.current.failures).not.toBe(before)
  })
})

describe('a finished join reaching the screen', () => {
  it('reports that an invitation settled', async () => {
    const { result } = renderHook(() => useMessagingPlayground(wallet, 'admin.test', 'test'))
    await waitFor(() => expect(result.current.client).toBeDefined())

    const seen: number[] = []
    const stop = result.current.onInvitationSettled(() => seen.push(1))

    // joinFromWelcome creates the group by a direct call, so no client event
    // fires locally. Without this the chat exists in storage while the list,
    // refreshed on welcomeReceived before the join ran, stays empty.
    await act(async () => {
      settled.forEach(notify => notify())
    })

    expect(seen).toHaveLength(1)
    stop()
  })

  it('stops reporting once unsubscribed', async () => {
    const { result } = renderHook(() => useMessagingPlayground(wallet, 'admin.test', 'test'))
    await waitFor(() => expect(result.current.client).toBeDefined())

    const seen: number[] = []
    const stop = result.current.onInvitationSettled(() => seen.push(1))
    stop()
    await act(async () => {
      settled.forEach(notify => notify())
    })

    expect(seen).toHaveLength(0)
  })
})
