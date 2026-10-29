/**
 * `ManagedInvitations` has to say when it has finished, not only when it fails.
 *
 * `joinFromWelcome` creates the group by a direct call, so the client emits
 * nothing a host could use to notice the chat now exists. The host refreshes
 * on `welcomeReceived`, which arrives *before* the join runs, finds nothing,
 * and never looks again — a chat in storage under an empty list.
 *
 * The hook's own test mocks this class, so it proves the plumbing and not the
 * call. This one uses the real thing.
 */
import { ManagedInvitations, MemoryShelf } from '../../core/messaging/managedInvitations'
import { PlaygroundChatIds } from '../../core/messaging/playgroundChatIds'

type Handler = (payload: unknown) => void

/** The smallest client the manager will attach to. */
function fakeClient() {
  const handlers = new Map<string, Handler[]>()
  return {
    fire: (event: string, payload: unknown) => (handlers.get(event) ?? []).forEach(h => h(payload)),
    client: {
      on: (event: string, handler: Handler) => {
        handlers.set(event, [...(handlers.get(event) ?? []), handler])
        return () => undefined
      },
      invites: { accept: async () => undefined, decline: async () => undefined },
      keyPackages: { create: async () => ({ keyPackage: new Uint8Array(), privateKeyPackage: new Uint8Array() }) },
      joinFromWelcome: async () => {
        throw new Error('join refused')
      }
    } as never
  }
}

describe('reporting that an invitation settled', () => {
  it('reports after a join that failed', async () => {
    const { client, fire } = fakeClient()
    const failures: unknown[] = []
    let settled = 0
    const invitations = new ManagedInvitations(
      client,
      new MemoryShelf(),
      new PlaygroundChatIds(),
      failure => failures.push(failure),
      () => {
        settled += 1
      }
    )
    invitations.start()

    fire('welcomeReceived', { inviteId: 'i1', peer: '02aa', ref: 'ref-1' })
    await new Promise(resolve => setImmediate(resolve))

    expect(failures).toHaveLength(1)
    // The point: a host that only hears about failures has no reason to
    // re-read its list after a join that worked.
    expect(settled).toBe(1)
  })

  it('survives a host whose own reporter throws', async () => {
    const { client, fire } = fakeClient()
    const invitations = new ManagedInvitations(
      client,
      new MemoryShelf(),
      new PlaygroundChatIds(),
      () => undefined,
      () => {
        throw new Error('the screen blew up')
      }
    )
    invitations.start()

    fire('welcomeReceived', { inviteId: 'i1', peer: '02aa', ref: 'ref-1' })

    // No unhandled rejection: the delivery loop outlives a broken host.
    await expect(new Promise(resolve => setImmediate(resolve))).resolves.toBeUndefined()
  })
})
