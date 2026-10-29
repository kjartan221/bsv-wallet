/**
 * MessagingPlaygroundScreen — the two things that are not obvious from reading it.
 *
 * The flag has to gate the client, not just the copy: an off build that still
 * opened a database and a socket would be shipping the playground while
 * claiming not to. `messagingPlaygroundShipGate.test.ts` pins which profiles
 * set the flag; this pins what the screen does with it.
 *
 * And "New chat" with several contacts picked is one chat, not several: every
 * invitation is remembered under the same local `chatId`, so the answers all
 * land in one group as they arrive.
 */
jest.mock('expo-haptics', () => ({
  selectionAsync: jest.fn(() => Promise.resolve()),
  impactAsync: jest.fn(() => Promise.resolve()),
  notificationAsync: jest.fn(() => Promise.resolve()),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
  NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' }
}))
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }))
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 })
}))
// One stable `t` and one stable return object, as i18next gives. A fresh
// function per render makes every callback closing over it unstable, re-runs
// the effects keyed off them on every render, and hides anything that depends
// on an explicit refresh.
const mockT = (key: string, o?: Record<string, unknown>) =>
  o && Object.keys(o).length ? `${key}:${JSON.stringify(o)}` : key
const mockTranslation = { t: mockT, i18n: { language: 'en' } }
jest.mock('react-i18next', () => ({ useTranslation: () => mockTranslation }))

const mockPush = jest.fn()
let mockFocus: (() => void) | undefined
jest.mock('expo-router', () => ({
  router: { push: (...a: unknown[]) => mockPush(...a), back: jest.fn() },
  useFocusEffect: (effect: () => void) => {
    mockFocus = effect
  }
}))

const mockShowToast = jest.fn()
jest.mock('../../ui/components/ui/Toast', () => ({ showToast: (...a: unknown[]) => mockShowToast(...a) }))

type AlertOptions = { title: string; message: string; buttons: unknown[] }
const mockShowAlert = jest.fn(async (_options: AlertOptions): Promise<string> => 'confirm')
jest.mock('../../ui/components/ui/AlertCard', () => ({ showAlert: (o: AlertOptions) => mockShowAlert(o) }))
jest.mock('../../ui/components/wallet/ContactSigil', () => 'ContactSigil')
jest.mock('../../ui/components/ui/GroupedList', () => {
  const React = require('react')
  const { Text } = require('react-native')
  // The real one renders its header; dropping it here would hide exactly the
  // section titles these tests assert on.
  return {
    GroupedSection: ({ header, children }: { header?: string; children: React.ReactNode }) =>
      React.createElement(React.Fragment, null, header ? React.createElement(Text, null, header) : null, children)
  }
})

let mockEnabled = true
const mockWritePlaygroundHost = jest.fn(async (_host: string) => {})
jest.mock('../../core/messaging/playground', () => ({
  DEFAULT_PLAYGROUND_MESSAGE_BOX_URL: 'https://relay.example.test',
  messagingPlaygroundEnabled: () => mockEnabled,
  readPlaygroundHost: async () => 'https://relay.example.test',
  writePlaygroundHost: (host: string) => mockWritePlaygroundHost(host)
}))

let mockChatIdSeq = 0
jest.mock('../../core/messaging/randomChatId', () => ({ randomChatId: () => `chat-${++mockChatIdSeq}` }))

const mockUseMessagingPlayground = jest.fn()
jest.mock('../../ui/hooks/useMessagingPlayground', () => ({
  useMessagingPlayground: (...a: unknown[]) => mockUseMessagingPlayground(...a)
}))

const mockListContacts = jest.fn()
// One stable object, the way the real `useContactsStore` memoises: a fresh one
// per render makes every callback keyed off it unstable, and an effect keyed
// off that re-fires forever.
const mockStore = { listContacts: (...a: unknown[]) => mockListContacts(...a) }
jest.mock('../../ui/hooks/useContactsStore', () => ({ useContactsStore: () => mockStore }))

jest.mock('@bsv/expo-wallet-toolbox', () => ({
  ...jest.requireActual('../../core/theme/tokens'),
  ...jest.requireActual('../../core/theme/motion'),
  ...jest.requireActual('../../core/hooks/useHaptics'),
  useTheme: () => ({ colors: {} }),
  useWallet: () => ({
    walletUserId: 1,
    managers: { permissionsManager: {} },
    selectedNetwork: 'test',
    adminOriginator: 'admin.test'
  })
}))

import React from 'react'
import { fireEvent, render, waitFor } from '@testing-library/react-native'
import { MessagingPlaygroundScreen } from '../../ui/screens/MessagingPlaygroundScreen'

const send = jest.fn()
const remember = jest.fn()
const reopen = jest.fn()
const reset = jest.fn(async () => {})
const chatNamesAll = jest.fn(async (): Promise<Record<string, string>> => ({}))
const listInvites = jest.fn(async (_direction: string): Promise<unknown[]> => [])
const acceptInvite = jest.fn(async (_id: string) => {})
const declineInvite = jest.fn(async (_id: string) => {})
const handlers = new Map<string, ((payload: any) => void)[]>()
const on = (event: string, handler: (payload: any) => void) => {
  handlers.set(event, [...(handlers.get(event) ?? []), handler])
  return () =>
    handlers.set(
      event,
      (handlers.get(event) ?? []).filter(h => h !== handler)
    )
}
const fire = (event: string, payload: unknown) => (handlers.get(event) ?? []).forEach(h => h(payload))

function group(chatId: string, name: string, memberKeys: string[]) {
  return { chatId, info: async () => ({ name, members: memberKeys.map(identityKey => ({ identityKey })) }) }
}

function playground(over: Record<string, unknown> = {}) {
  return {
    client: { identityKey: '02me', listGroups: async () => [], invites: { send, list: listInvites }, on },
    chatIds: { remember, nameFor: (id: string) => (id === 'i1' ? 'Standup' : undefined) },
    invitations: { accept: acceptInvite, decline: declineInvite },
    failures: [],
    chatNames: { all: chatNamesAll, set: jest.fn(async () => undefined) },
    live: { phase: 'subscribed' },
    opening: false,
    error: undefined,
    reopen,
    reset,
    onInvitationSettled: () => () => undefined,
    ...over
  }
}

const inboundRequest = {
  inviteId: 'i1',
  direction: 'inbound',
  kind: 'keyPackageRequest',
  peer: '02aa',
  chatName: 'TestMessaging'
}

beforeEach(() => {
  jest.clearAllMocks()
  listInvites.mockResolvedValue([])
  chatNamesAll.mockResolvedValue({})
  handlers.clear()
  mockEnabled = true
  mockChatIdSeq = 0
  // The real hook opens nothing without a wallet, and the flag is what
  // decides whether it gets one. Both handles are built once, not per render:
  // the real one holds its client in state, and a fresh object each render
  // would re-run every effect keyed off it and mask anything that needs an
  // explicit refresh.
  const withWallet = playground()
  const withoutWallet = playground({ client: undefined })
  mockUseMessagingPlayground.mockImplementation((wallet: unknown) =>
    wallet === undefined ? withoutWallet : withWallet
  )
  mockListContacts.mockResolvedValue([])
})

describe('MessagingPlaygroundScreen', () => {
  it('opens no client when the flag is off', async () => {
    mockEnabled = false
    const screen = render(<MessagingPlaygroundScreen />)
    await waitFor(() => expect(screen.getByText('messaging_off_title')).toBeTruthy())
    // The hook decides whether to open a database and a socket purely from the
    // wallet it is handed, so an undefined wallet is the whole gate.
    expect(mockUseMessagingPlayground).toHaveBeenCalledWith(undefined, 'admin.test', 'test', undefined)
  })

  it('opens a client when the flag is on', async () => {
    render(<MessagingPlaygroundScreen />)

    expect(mockUseMessagingPlayground.mock.calls[0][0]).toBeDefined()
  })

  it('lists chats with their member count and routes to one', async () => {
    mockUseMessagingPlayground.mockReturnValue(
      playground({
        client: {
          identityKey: '02me',
          listGroups: async () => [group('abc', 'Standup', ['02me', '02aa', '02bb'])],
          invites: { send, list: listInvites },
          on
        }
      })
    )
    const screen = render(<MessagingPlaygroundScreen />)

    await waitFor(() => expect(screen.getByText('Standup')).toBeTruthy())
    expect(screen.getByText('messaging_member_count:{"count":3}')).toBeTruthy()

    fireEvent.press(screen.getByLabelText('Standup'))
    expect(mockPush).toHaveBeenCalledWith({ pathname: '/messaging/[chatId]', params: { chatId: 'abc' } })
  })

  it('invites every picked contact under one chat id', async () => {
    mockListContacts.mockResolvedValue([
      { identityKey: '02aa', name: 'Ada' },
      { identityKey: '02bb', name: 'Grace' }
    ])
    send.mockImplementation(async (key: string) => `invite-${key}`)

    const screen = render(<MessagingPlaygroundScreen />)
    await waitFor(() => expect(screen.getByText('messaging_new_chat')).toBeTruthy())

    fireEvent.press(screen.getByText('messaging_new_chat'))
    await waitFor(() => expect(screen.getByLabelText('Ada')).toBeTruthy())

    fireEvent.press(screen.getByLabelText('Ada'))
    fireEvent.press(screen.getByLabelText('Grace'))
    fireEvent.press(screen.getByText('messaging_invite_count:{"count":2}'))
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2))

    // One name for the chat, carried by every invitation in it.
    expect(send).toHaveBeenNthCalledWith(1, '02aa', { chatName: 'Ada, Grace' })
    expect(send).toHaveBeenNthCalledWith(2, '02bb', { chatName: 'Ada, Grace' })
    expect(remember.mock.calls.map(call => call[1].chatId)).toEqual(['chat-1', 'chat-1'])
  })

  it('offers adding a contact from the picker, and shows it on return', async () => {
    mockListContacts.mockResolvedValue([])
    const screen = render(<MessagingPlaygroundScreen />)
    await waitFor(() => expect(screen.getByText('messaging_new_chat')).toBeTruthy())

    fireEvent.press(screen.getByText('messaging_new_chat'))
    await waitFor(() => expect(screen.getByText('messaging_no_contacts')).toBeTruthy())

    fireEvent.press(screen.getByText('contact_new_title'))
    expect(mockPush).toHaveBeenCalledWith('/contact/add')

    // Coming back from the add screen: the contact just created has to appear
    // without reopening the picker. `/contact/add` is a route, so expo-router
    // refocuses this screen rather than remounting it.
    mockListContacts.mockResolvedValue([{ identityKey: '02cc', name: 'Hopper' }])
    expect(typeof mockFocus).toBe('function')
    mockFocus?.()

    await waitFor(() => expect(screen.getByLabelText('Hopper')).toBeTruthy())
  })

  it('shows invitations that have been sent but not answered', async () => {
    listInvites.mockImplementation(async (direction: string) =>
      direction === 'outbound'
        ? [{ inviteId: 'i1', direction, kind: 'keyPackageRequest', peer: '02aa', chatName: 'Standup' }]
        : []
    )
    const screen = render(<MessagingPlaygroundScreen />)

    // Without this the inviter sees nothing at all between sending and the
    // first answer, which is indistinguishable from a failure.
    await waitFor(() => expect(screen.getByText('messaging_pending_title')).toBeTruthy())
    expect(screen.getByText('Standup')).toBeTruthy()
  })

  it('shows an invitation arriving on the other side', async () => {
    listInvites.mockImplementation(async (direction: string) =>
      direction === 'inbound' ? [{ inviteId: 'i2', direction, kind: 'welcome', peer: '02bb', chatName: 'Standup' }] : []
    )
    const screen = render(<MessagingPlaygroundScreen />)

    await waitFor(() => expect(screen.getByText('messaging_pending_title')).toBeTruthy())
  })

  it('surfaces a failed exchange instead of staying silent', async () => {
    mockUseMessagingPlayground.mockImplementation((wallet: unknown) =>
      playground(
        wallet === undefined
          ? { client: undefined }
          : { failures: [{ stage: 'join', chatId: 'abc', peer: '02cc', reason: 'relay refused' }] }
      )
    )
    const screen = render(<MessagingPlaygroundScreen />)

    await waitFor(() => expect(screen.getByText('messaging_failed_title')).toBeTruthy())
    expect(screen.getByText(/relay refused/)).toBeTruthy()
  })

  it('offers accept and reject on an invitation that needs an answer', async () => {
    listInvites.mockImplementation(async d => (d === 'inbound' ? [inboundRequest] : []))
    const screen = render(<MessagingPlaygroundScreen />)

    await waitFor(() => expect(screen.getByText('messaging_accept')).toBeTruthy())
    expect(screen.getByText('reject')).toBeTruthy()
    // Who it is from, so a stranger's invitation is not accepted blind.
    expect(screen.getByText(/02aa/)).toBeTruthy()
  })

  it('answers the invitation when accepted', async () => {
    listInvites.mockImplementation(async d => (d === 'inbound' ? [inboundRequest] : []))
    const screen = render(<MessagingPlaygroundScreen />)
    await waitFor(() => expect(screen.getByText('messaging_accept')).toBeTruthy())

    fireEvent.press(screen.getByText('messaging_accept'))
    await waitFor(() => expect(acceptInvite).toHaveBeenCalledWith('i1'))
    expect(declineInvite).not.toHaveBeenCalled()
  })

  it('declines and drops the row when rejected', async () => {
    listInvites.mockImplementation(async d => (d === 'inbound' ? [inboundRequest] : []))
    const screen = render(<MessagingPlaygroundScreen />)
    await waitFor(() => expect(screen.getByText('reject')).toBeTruthy())

    listInvites.mockImplementation(async () => [])
    fireEvent.press(screen.getByText('reject'))

    await waitFor(() => expect(declineInvite).toHaveBeenCalledWith('i1'))
    await waitFor(() => expect(screen.queryByText('reject')).toBeNull())
  })

  it('leaves a welcome alone: it is joined without asking', async () => {
    listInvites.mockImplementation(async d => (d === 'inbound' ? [{ ...inboundRequest, kind: 'welcome' }] : []))
    const screen = render(<MessagingPlaygroundScreen />)

    await waitFor(() => expect(screen.getByText('messaging_pending_title')).toBeTruthy())
    expect(screen.queryByText('messaging_accept')).toBeNull()
    expect(screen.queryByText('reject')).toBeNull()
  })

  it('leaves an invitation we sent alone', async () => {
    listInvites.mockImplementation(async d => (d === 'outbound' ? [{ ...inboundRequest, direction: 'outbound' }] : []))
    const screen = render(<MessagingPlaygroundScreen />)

    await waitFor(() => expect(screen.getByText('messaging_pending_sent')).toBeTruthy())
    expect(screen.queryByText('messaging_accept')).toBeNull()
  })

  it('tells the inviter their invitation was rejected', async () => {
    const screen = render(<MessagingPlaygroundScreen />)
    await waitFor(() => expect(screen.getByText('messaging_new_chat')).toBeTruthy())

    fire('inviteDeclined', { inviteId: 'i1', peer: '02aa' })

    await waitFor(() => expect(screen.getByText('messaging_failed_title')).toBeTruthy())
    // Named from the chat ids the inviter kept; the event carries no chatName.
    expect(screen.getByText('Standup')).toBeTruthy()
    expect(screen.getByText('messaging_declined')).toBeTruthy()
  })

  it('clears a rejection from the list', async () => {
    const screen = render(<MessagingPlaygroundScreen />)
    await waitFor(() => expect(screen.getByText('messaging_new_chat')).toBeTruthy())
    fire('inviteDeclined', { inviteId: 'i1', peer: '02aa' })
    await waitFor(() => expect(screen.getByText('messaging_declined')).toBeTruthy())

    fireEvent.press(screen.getByLabelText('dismiss'))

    await waitFor(() => expect(screen.queryByText('messaging_declined')).toBeNull())
  })

  it('names an incoming invitation after the inviter, not the chat', async () => {
    // The inviter names the chat after the person they invited, so showing
    // chatName here shows the invitee their own name.
    mockListContacts.mockResolvedValue([{ identityKey: '02aa', name: 'Ada' }])
    listInvites.mockImplementation(async d => (d === 'inbound' ? [inboundRequest] : []))
    const screen = render(<MessagingPlaygroundScreen />)

    await waitFor(() => expect(screen.getByText('Ada')).toBeTruthy())
    expect(screen.queryByText('TestMessaging')).toBeNull()
  })

  it('falls back to the key when the inviter is not a contact', async () => {
    mockListContacts.mockResolvedValue([])
    listInvites.mockImplementation(async d => (d === 'inbound' ? [inboundRequest] : []))
    const screen = render(<MessagingPlaygroundScreen />)

    await waitFor(() => expect(screen.getByText('messaging_pending_title')).toBeTruthy())
    expect(screen.getByText(/02aa/)).toBeTruthy()
  })

  it('still names an invitation we sent after the chat', async () => {
    listInvites.mockImplementation(async d => (d === 'outbound' ? [{ ...inboundRequest, direction: 'outbound' }] : []))
    const screen = render(<MessagingPlaygroundScreen />)

    await waitFor(() => expect(screen.getByText('TestMessaging')).toBeTruthy())
  })

  it('shows the invitation it just sent, without waiting for an event', async () => {
    mockListContacts.mockResolvedValue([{ identityKey: '02aa', name: 'Ada' }])
    send.mockImplementation(async (key: string) => `invite-${key}`)
    const screen = render(<MessagingPlaygroundScreen />)
    await waitFor(() => expect(screen.getByText('messaging_new_chat')).toBeTruthy())

    fireEvent.press(screen.getByText('messaging_new_chat'))
    await waitFor(() => expect(screen.getByLabelText('Ada')).toBeTruthy())
    fireEvent.press(screen.getByLabelText('Ada'))

    // The relay only tells us about other people's invitations, so without a
    // refresh here the sender sees nothing at all until some unrelated event
    // happens to reload the list.
    listInvites.mockImplementation(async d =>
      d === 'outbound' ? [{ ...inboundRequest, direction: 'outbound', chatName: 'Ada' }] : []
    )
    fireEvent.press(screen.getByText('messaging_invite_count:{"count":1}'))

    await waitFor(() => expect(screen.getByText('messaging_pending_sent')).toBeTruthy())
  })

  it('clears chats and invitations once confirmed', async () => {
    mockShowAlert.mockResolvedValue('confirm')
    const screen = render(<MessagingPlaygroundScreen />)
    await waitFor(() => expect(screen.getByLabelText('messaging_relay_edit')).toBeTruthy())
    fireEvent.press(screen.getByLabelText('messaging_relay_edit'))

    fireEvent.press(screen.getByText('messaging_reset'))

    await waitFor(() => expect(reset).toHaveBeenCalled())
  })

  it('does not clear anything when the confirm is declined', async () => {
    mockShowAlert.mockResolvedValue('cancel')
    const screen = render(<MessagingPlaygroundScreen />)
    await waitFor(() => expect(screen.getByLabelText('messaging_relay_edit')).toBeTruthy())
    fireEvent.press(screen.getByLabelText('messaging_relay_edit'))

    fireEvent.press(screen.getByText('messaging_reset'))

    await waitFor(() => expect(mockShowAlert).toHaveBeenCalled())
    expect(reset).not.toHaveBeenCalled()
  })

  it('asks before clearing, and says contacts are kept', async () => {
    const screen = render(<MessagingPlaygroundScreen />)
    await waitFor(() => expect(screen.getByLabelText('messaging_relay_edit')).toBeTruthy())
    fireEvent.press(screen.getByLabelText('messaging_relay_edit'))

    fireEvent.press(screen.getByText('messaging_reset'))

    await waitFor(() => expect(mockShowAlert).toHaveBeenCalled())
    const options = mockShowAlert.mock.calls[0][0]
    expect(options.title).toBe('messaging_reset_title')
    expect(options.message).toBe('messaging_reset_body')
    expect(options.buttons).toHaveLength(2)
  })

  it('names a 1:1 chat after the other person, not the stored name', async () => {
    // The stored name is whatever the inviter called the chat — which, for a
    // 1:1, is the invitee's own name. Both sides should see the other person.
    mockListContacts.mockResolvedValue([{ identityKey: '02aa', name: 'Ada' }])
    mockUseMessagingPlayground.mockImplementation((w: unknown) =>
      w === undefined
        ? playground({ client: undefined })
        : playground({
            client: {
              identityKey: '02me',
              listGroups: async () => [group('c1', 'Me, as they named it', ['02me', '02aa'])],
              invites: { send, list: listInvites },
              on
            }
          })
    )
    const screen = render(<MessagingPlaygroundScreen />)

    await waitFor(() => expect(screen.getByText('Ada')).toBeTruthy())
    expect(screen.queryByText('Me, as they named it')).toBeNull()
  })

  it('falls back to the key when the other person is not a contact', async () => {
    mockListContacts.mockResolvedValue([])
    mockUseMessagingPlayground.mockImplementation((w: unknown) =>
      w === undefined
        ? playground({ client: undefined })
        : playground({
            client: {
              identityKey: '02me',
              listGroups: async () => [group('c1', 'whatever', ['02me', '02aa'])],
              invites: { send, list: listInvites },
              on
            }
          })
    )
    const screen = render(<MessagingPlaygroundScreen />)

    await waitFor(() => expect(screen.getByText(/02aa/)).toBeTruthy())
  })

  it('keeps the shared name for a group, where it means something', async () => {
    mockListContacts.mockResolvedValue([{ identityKey: '02aa', name: 'Ada' }])
    mockUseMessagingPlayground.mockImplementation((w: unknown) =>
      w === undefined
        ? playground({ client: undefined })
        : playground({
            client: {
              identityKey: '02me',
              listGroups: async () => [group('c1', 'Standup', ['02me', '02aa', '02bb'])],
              invites: { send, list: listInvites },
              on
            }
          })
    )
    const screen = render(<MessagingPlaygroundScreen />)

    // Three members: the name is shared and means the same to everyone.
    await waitFor(() => expect(screen.getByText('Standup')).toBeTruthy())
  })

  it('sends the chat name typed into the picker', async () => {
    mockListContacts.mockResolvedValue([
      { identityKey: '02aa', name: 'Ada' },
      { identityKey: '02bb', name: 'Grace' }
    ])
    send.mockImplementation(async (key: string) => `invite-${key}`)
    const screen = render(<MessagingPlaygroundScreen />)
    await waitFor(() => expect(screen.getByText('messaging_new_chat')).toBeTruthy())

    fireEvent.press(screen.getByText('messaging_new_chat'))
    await waitFor(() => expect(screen.getByLabelText('Ada')).toBeTruthy())
    fireEvent.press(screen.getByLabelText('Ada'))
    fireEvent.press(screen.getByLabelText('Grace'))
    fireEvent.changeText(screen.getByLabelText('messaging_chat_name'), 'Launch crew')
    fireEvent.press(screen.getByText('messaging_invite_count:{"count":2}'))

    await waitFor(() => expect(send).toHaveBeenCalledTimes(2))
    expect(send).toHaveBeenNthCalledWith(1, '02aa', { chatName: 'Launch crew' })
    expect(send).toHaveBeenNthCalledWith(2, '02bb', { chatName: 'Launch crew' })
  })

  it('names a group after its members when nothing is typed', async () => {
    mockListContacts.mockResolvedValue([
      { identityKey: '02aa', name: 'Ada' },
      { identityKey: '02bb', name: 'Grace' }
    ])
    send.mockImplementation(async (key: string) => `invite-${key}`)
    const screen = render(<MessagingPlaygroundScreen />)
    await waitFor(() => expect(screen.getByText('messaging_new_chat')).toBeTruthy())

    fireEvent.press(screen.getByText('messaging_new_chat'))
    await waitFor(() => expect(screen.getByLabelText('Ada')).toBeTruthy())
    fireEvent.press(screen.getByLabelText('Ada'))
    fireEvent.press(screen.getByLabelText('Grace'))
    fireEvent.press(screen.getByText('messaging_invite_count:{"count":2}'))

    await waitFor(() => expect(send).toHaveBeenCalledTimes(2))
    expect(send).toHaveBeenNthCalledWith(1, '02aa', { chatName: 'Ada, Grace' })
  })

  it('shows the name this device gave a chat, over the derived one', async () => {
    mockListContacts.mockResolvedValue([{ identityKey: '02aa', name: 'Ada' }])
    chatNamesAll.mockResolvedValue({ c1: 'Renamed here' })
    mockUseMessagingPlayground.mockImplementation((w: unknown) =>
      w === undefined
        ? playground({ client: undefined })
        : playground({
            client: {
              identityKey: '02me',
              listGroups: async () => [group('c1', 'Shared name', ['02me', '02aa'])],
              invites: { send, list: listInvites },
              on
            }
          })
    )
    const screen = render(<MessagingPlaygroundScreen />)

    await waitFor(() => expect(screen.getByText('Renamed here')).toBeTruthy())
    // Neither the shared name nor the other member outranks a local choice.
    expect(screen.queryByText('Ada')).toBeNull()
    expect(screen.queryByText('Shared name')).toBeNull()
  })

  it('reopens the client after the relay is changed', async () => {
    const screen = render(<MessagingPlaygroundScreen />)
    await waitFor(() => expect(screen.getByLabelText('messaging_relay_edit')).toBeTruthy())

    fireEvent.press(screen.getByLabelText('messaging_relay_edit'))
    fireEvent.changeText(screen.getByLabelText('messaging_relay_title'), 'https://other.example.test')
    fireEvent.press(screen.getByText('save'))

    await waitFor(() => expect(reopen).toHaveBeenCalled())
    expect(mockWritePlaygroundHost).toHaveBeenCalledWith('https://other.example.test')
  })

  it('offers a retry when the client could not open', async () => {
    mockUseMessagingPlayground.mockReturnValue(playground({ client: undefined, error: 'relay refused' }))
    const screen = render(<MessagingPlaygroundScreen />)
    await waitFor(() => expect(screen.getByText('messaging_open_failed')).toBeTruthy())

    expect(screen.getByText('relay refused')).toBeTruthy()

    fireEvent.press(screen.getByText('retry'))
    expect(reopen).toHaveBeenCalled()
  })
})
