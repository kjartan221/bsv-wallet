/**
 * Does @bsv/group-messaging actually run in this app's runtime?
 *
 * The library is pure TypeScript but it reaches for `crypto.getRandomValues`,
 * `TextEncoder`/`TextDecoder` and `btoa`/`atob`, none of which Hermes ships by
 * default, and it pulls in `ts-mls` plus `@noble/*`. A screen that imports it
 * is a poor place to discover any of that is missing, so this pins it: the
 * package imports, a client is created, and one encrypted message goes between
 * two identities over the in-process hub — no network, no relay.
 *
 * The playground itself uses a real MessageBox transport; this test
 * deliberately does not, so a failure here is the library or the runtime and
 * never the network.
 *
 * What it does NOT prove, and what cost a debugging session to learn: this
 * runs on Node, not Hermes, and on the library's default ciphersuite rather
 * than the playground's. Node's WebCrypto generates Ed25519 keys happily;
 * `react-native-quick-crypto`'s `subtle.generateKey` has that case commented
 * out, so the default suite throws on device at the first KeyPackage. The
 * playground pins P-256 for that reason — see `PLAYGROUND_CIPHERSUITE`.
 *
 * The suite is deliberately NOT pinned here. P-256 signatures reach
 * `@noble/curves` through a dynamic `import()`, which jest cannot run without
 * `--experimental-vm-modules`; Metro compiles it to its own async require and
 * resolves it. So this test covers "the library loads and an exchange works",
 * and the device covers the rest.
 */
import { GroupMessagingClient, InProcessTransportHub } from '@bsv/group-messaging'
import { KeyDeriver, PrivateKey } from '@bsv/sdk'

jest.setTimeout(30_000)

describe('@bsv/group-messaging in this runtime', () => {
  it('carries an encrypted message between two identities', async () => {
    const hub = new InProcessTransportHub()
    const aliceKey = PrivateKey.fromRandom()
    const bobKey = PrivateKey.fromRandom()
    const aliceId = new KeyDeriver(aliceKey).identityKey
    const bobId = new KeyDeriver(bobKey).identityKey

    const alice = await GroupMessagingClient.create({
      wallet: aliceKey,
      storage: 'memory',
      transport: hub.endpoint(aliceId)
    })
    const bob = await GroupMessagingClient.create({
      wallet: bobKey,
      storage: 'memory',
      transport: hub.endpoint(bobId)
    })

    const bobKp = await bob.keyPackages.create()
    const aliceKp = await alice.keyPackages.create()

    const heard: string[] = []
    const welcomed = new Promise<{ inviteId: string }>(resolve => {
      const stop = bob.on('welcomeReceived', payload => {
        stop()
        resolve(payload)
      })
    })
    bob.on('message', ({ content }) => {
      if (content.type === 'text' && content.body !== undefined) heard.push(content.body)
    })

    await alice.createGroup({
      chatId: 'runtime-check',
      members: [bobKp.keyPackage],
      privateKeyPackage: aliceKp.privateKeyPackage
    })

    const { inviteId } = await welcomed
    await bob.joinFromWelcome({
      inviteId,
      chatId: 'runtime-check',
      privateKeyPackage: bobKp.privateKeyPackage
    })

    const group = await alice.getGroup('runtime-check')
    await group?.sendText('hello from the runtime check')

    expect(heard).toEqual(['hello from the runtime check'])

    await alice.close()
    await bob.close()
  })
})
