/**
 * The Curve25519 shim, checked against a real WebCrypto.
 *
 * `react-native-quick-crypto@0.7.17` installs a `subtle` whose `generateKey`
 * has the whole cfrg family commented out, so Ed25519 and X25519 throw on
 * device — and because something called `subtle` exists, every library in the
 * MLS stack prefers it over its own pure-JS fallback. This shim fills those two
 * algorithms in and delegates everything else.
 *
 * It is pure JavaScript, which makes it the one part of this problem that can
 * be tested off-device: Node's WebCrypto implements both curves, so it serves
 * as an oracle. Keys made here are imported there and vice versa, and a
 * signature or shared secret that disagrees fails the test. That is a much
 * stronger check than "it did not throw on the emulator".
 */
import { webcrypto } from 'node:crypto'
import { makeCurve25519Subtle } from '../../core/crypto/curve25519Subtle'

const oracle = webcrypto.subtle as unknown as SubtleCrypto

/** A delegate that records what it was handed and otherwise refuses. */
function delegate() {
  const calls: string[] = []
  const refuse =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push(`${name}:${JSON.stringify(args[0])}`)
      return Promise.resolve('delegated')
    }
  return {
    calls,
    api: {
      generateKey: refuse('generateKey'),
      importKey: refuse('importKey'),
      exportKey: refuse('exportKey'),
      sign: refuse('sign'),
      verify: refuse('verify'),
      deriveBits: refuse('deriveBits'),
      digest: refuse('digest')
    } as unknown as SubtleCrypto
  }
}

const subtle = makeCurve25519Subtle(delegate().api)
const bytes = (b: ArrayBuffer | Uint8Array) => new Uint8Array(b as ArrayBuffer)

describe('Ed25519', () => {
  it('produces a signature the oracle accepts', async () => {
    const pair = (await subtle.generateKey('Ed25519', true, ['sign', 'verify'])) as CryptoKeyPair
    const message = new TextEncoder().encode('mls key package')

    const signature = await subtle.sign('Ed25519', pair.privateKey, message)

    const raw = await subtle.exportKey('raw', pair.publicKey)
    const theirs = await oracle.importKey('raw', raw, 'Ed25519', true, ['verify'])
    expect(await oracle.verify('Ed25519', theirs, signature, message)).toBe(true)
  })

  it('accepts a signature the oracle produced', async () => {
    const theirs = (await oracle.generateKey('Ed25519', true, ['sign', 'verify'])) as CryptoKeyPair
    const message = new TextEncoder().encode('from the other side')
    const signature = await oracle.sign('Ed25519', theirs.privateKey, message)

    const raw = await oracle.exportKey('raw', theirs.publicKey)
    const ours = await subtle.importKey('raw', raw, 'Ed25519', true, ['verify'])

    expect(await subtle.verify('Ed25519', ours, signature, message)).toBe(true)
  })

  it('rejects a tampered signature', async () => {
    const pair = (await subtle.generateKey('Ed25519', true, ['sign', 'verify'])) as CryptoKeyPair
    const message = new TextEncoder().encode('mls key package')
    const signature = bytes(await subtle.sign('Ed25519', pair.privateKey, message))
    signature[0] ^= 1

    expect(await subtle.verify('Ed25519', pair.publicKey, signature, message)).toBe(false)
  })

  it('round-trips a private key through pkcs8, as ts-mls does', async () => {
    const pair = (await subtle.generateKey('Ed25519', true, ['sign', 'verify'])) as CryptoKeyPair
    const pkcs8 = await subtle.exportKey('pkcs8', pair.privateKey)

    // The oracle parsing our DER is the real assertion: a malformed wrapper
    // would be accepted by our own importKey and by nothing else.
    const theirs = await oracle.importKey('pkcs8', pkcs8, 'Ed25519', true, ['sign'])
    const message = new TextEncoder().encode('round trip')
    const signature = await oracle.sign('Ed25519', theirs, message)

    expect(await subtle.verify('Ed25519', pair.publicKey, signature, message)).toBe(true)
  })

  it('imports a pkcs8 key the oracle wrote', async () => {
    const theirs = (await oracle.generateKey('Ed25519', true, ['sign', 'verify'])) as CryptoKeyPair
    const pkcs8 = await oracle.exportKey('pkcs8', theirs.privateKey)

    const ours = await subtle.importKey('pkcs8', pkcs8, 'Ed25519', true, ['sign'])
    const message = new TextEncoder().encode('their key, our signature')
    const signature = await subtle.sign('Ed25519', ours, message)

    expect(await oracle.verify('Ed25519', theirs.publicKey, signature, message)).toBe(true)
  })
})

describe('X25519', () => {
  it('agrees with the oracle on a shared secret', async () => {
    const ours = (await subtle.generateKey('X25519', true, ['deriveBits'])) as CryptoKeyPair
    const theirs = (await oracle.generateKey('X25519', true, ['deriveBits'])) as CryptoKeyPair

    const theirPublicRaw = await oracle.exportKey('raw', theirs.publicKey)
    const theirPublic = await subtle.importKey('raw', theirPublicRaw, 'X25519', true, [])
    const ourSecret = bytes(await subtle.deriveBits({ name: 'X25519', public: theirPublic }, ours.privateKey, 256))

    const ourPublicRaw = await subtle.exportKey('raw', ours.publicKey)
    const ourPublic = await oracle.importKey('raw', ourPublicRaw, 'X25519', true, [])
    const theirSecret = bytes(await oracle.deriveBits({ name: 'X25519', public: ourPublic }, theirs.privateKey, 256))

    expect(ourSecret).toHaveLength(32)
    expect(Array.from(ourSecret)).toEqual(Array.from(theirSecret))
  })

  it('round-trips a private key through pkcs8', async () => {
    const ours = (await subtle.generateKey('X25519', true, ['deriveBits'])) as CryptoKeyPair
    const pkcs8 = await subtle.exportKey('pkcs8', ours.privateKey)

    const theirs = await oracle.importKey('pkcs8', pkcs8, 'X25519', true, ['deriveBits'])
    const peer = (await oracle.generateKey('X25519', true, ['deriveBits'])) as CryptoKeyPair

    const a = bytes(await oracle.deriveBits({ name: 'X25519', public: peer.publicKey }, theirs, 256))
    const peerRaw = await oracle.exportKey('raw', peer.publicKey)
    const peerHere = await subtle.importKey('raw', peerRaw, 'X25519', true, [])
    const b = bytes(await subtle.deriveBits({ name: 'X25519', public: peerHere }, ours.privateKey, 256))

    expect(Array.from(a)).toEqual(Array.from(b))
  })

  it('round-trips through jwk, which is how hpke moves these keys', async () => {
    const ours = (await subtle.generateKey('X25519', true, ['deriveBits'])) as CryptoKeyPair
    const jwk = (await subtle.exportKey('jwk', ours.privateKey)) as JsonWebKey

    expect(jwk.kty).toBe('OKP')
    expect(jwk.crv).toBe('X25519')
    const theirs = await oracle.importKey('jwk', jwk, 'X25519', true, ['deriveBits'])
    expect(theirs.type).toBe('private')
  })

  it('writes base64url, which is the bug that started this', async () => {
    const ours = (await subtle.generateKey('X25519', true, ['deriveBits'])) as CryptoKeyPair
    const jwk = (await subtle.exportKey('jwk', ours.privateKey)) as JsonWebKey

    // quick-crypto emitted standard base64 with a stray '.' here, which Hermes'
    // atob refused and hpke surfaced as SerializeError.
    for (const field of [jwk.d, jwk.x]) {
      expect(field).toBeDefined()
      expect(field).toMatch(/^[A-Za-z0-9_-]+$/)
    }
  })
})

describe('everything else', () => {
  it('passes an algorithm it does not implement to the delegate', async () => {
    const d = delegate()
    const wrapped = makeCurve25519Subtle(d.api)

    await wrapped.generateKey({ name: 'AES-GCM', length: 256 } as AesKeyGenParams, true, ['encrypt'])
    await wrapped.digest('SHA-256', new Uint8Array([1, 2, 3]))

    expect(d.calls).toEqual(['generateKey:{"name":"AES-GCM","length":256}', 'digest:"SHA-256"'])
  })

  it('does not intercept ECDH, which quick-crypto does implement', async () => {
    const d = delegate()
    const wrapped = makeCurve25519Subtle(d.api)

    await wrapped.generateKey({ name: 'ECDH', namedCurve: 'P-256' } as EcKeyGenParams, true, ['deriveBits'])

    expect(d.calls).toHaveLength(1)
    expect(d.calls[0]).toContain('ECDH')
  })
})

describe('HMAC', () => {
  // quick-crypto imports HMAC keys but leaves sign and verify commented out,
  // so hpke's HKDF and ts-mls's own MAC both die on it. Same treatment as the
  // curves: implement it, check it against a real one.
  const hashes = ['SHA-256', 'SHA-384', 'SHA-512'] as const

  it.each(hashes)('agrees with the oracle on a %s tag', async hash => {
    const secret = new Uint8Array(32).fill(7)
    const data = new TextEncoder().encode('mls transcript')

    const ours = await subtle.importKey('raw', secret, { name: 'HMAC', hash }, false, ['sign'])
    const theirs = await oracle.importKey('raw', secret, { name: 'HMAC', hash }, false, ['sign'])

    const a = bytes(await subtle.sign('HMAC', ours, data))
    const b = bytes(await oracle.sign('HMAC', theirs, data))

    expect(Array.from(a)).toEqual(Array.from(b))
  })

  it('verifies a tag the oracle produced', async () => {
    const secret = new Uint8Array(32).fill(3)
    const data = new TextEncoder().encode('from the other side')
    const theirs = await oracle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    const tag = await oracle.sign('HMAC', theirs, data)

    const ours = await subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'])

    expect(await subtle.verify('HMAC', ours, tag, data)).toBe(true)
  })

  it('rejects a tampered tag', async () => {
    const secret = new Uint8Array(32).fill(3)
    const data = new TextEncoder().encode('tampered')
    const ours = await subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
    const tag = bytes(await subtle.sign('HMAC', ours, data))
    tag[0] ^= 1

    expect(await subtle.verify('HMAC', ours, tag, data)).toBe(false)
  })

  it('accepts the hash given as an object, which is how hpke passes it', async () => {
    const secret = new Uint8Array(32).fill(9)
    const data = new TextEncoder().encode('object form')

    const ours = await subtle.importKey('raw', secret, { name: 'HMAC', hash: { name: 'SHA-256' } }, false, ['sign'])
    const theirs = await oracle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])

    expect(Array.from(bytes(await subtle.sign('HMAC', ours, data)))).toEqual(
      Array.from(bytes(await oracle.sign('HMAC', theirs, data)))
    )
  })

  it('round-trips a generated key through raw', async () => {
    const generated = (await subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, true, ['sign'])) as CryptoKey
    const raw = bytes(await subtle.exportKey('raw', generated))

    expect(raw).toHaveLength(32)
    const reimported = await subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    const data = new TextEncoder().encode('round trip')
    expect(Array.from(bytes(await subtle.sign('HMAC', reimported, data)))).toEqual(
      Array.from(bytes(await subtle.sign('HMAC', generated, data)))
    )
  })
})
