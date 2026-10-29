/**
 * Clearing the playground's own data, and nothing else.
 *
 * The playground keeps group state and invitations in its own SQLite file.
 * Contacts do not live there — they are a table in the wallet's database,
 * created by `core/storage/schema/createTables.ts` — so clearing this one
 * cannot reach them. That separation is the safety property, and this pins it
 * by name: a reset that ever names another database is a bug.
 *
 * The close has to happen before the delete. SQLite will not remove a file the
 * process still holds open, and a half-deleted database is worse than a full
 * one.
 */
const deleted: string[] = []
const closed: string[] = []

jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: async (name: string) => ({
    closeAsync: async () => {
      closed.push(name)
    },
    execAsync: async () => undefined,
    runAsync: async () => undefined,
    getAllAsync: async () => []
  }),
  deleteDatabaseAsync: async (name: string) => {
    if (closed[closed.length - 1] !== name) throw new Error(`database ${name} is still open`)
    deleted.push(name)
  }
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
  GroupMessagingClient: { create: async () => ({ identityKey: '02ab', close: async () => undefined }) }
}))

import { deletePlaygroundData, openPlaygroundClient, PLAYGROUND_DATABASE_NAME } from '../../core/messaging/playground'

beforeEach(() => {
  deleted.length = 0
  closed.length = 0
})

describe('clearing the playground', () => {
  it('closes the database before deleting it', async () => {
    // Previously nothing closed it: openPlaygroundClient opened the file and
    // handed back no way to shut it. Deleting underneath an open handle left
    // every later query rejecting with a native null pointer.
    const opened = await openPlaygroundClient({
      wallet: { getPublicKey: async () => ({ publicKey: '02' }) },
      adminOriginator: 'admin.test',
      chain: 'test',
      host: 'https://relay.example.test'
    })

    await opened.close()
    await deletePlaygroundData()

    expect(closed).toEqual([PLAYGROUND_DATABASE_NAME])
    expect(deleted).toEqual([PLAYGROUND_DATABASE_NAME])
  })

  it('names a database of its own, not the wallet one', () => {
    // Contacts, transactions and keys are in `wallet-<id>-<network>-<n>.db`.
    expect(PLAYGROUND_DATABASE_NAME).toBe('group-messaging-playground.db')
    expect(PLAYGROUND_DATABASE_NAME).not.toContain('wallet')
  })

  it('refuses to delete a database that is still open', async () => {
    // Nothing closed: the mock stands in for SQLite's own refusal.
    await expect(deletePlaygroundData()).rejects.toThrow(/still open/)
    expect(deleted).toEqual([])
  })
})
