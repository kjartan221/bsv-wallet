/**
 * The conformance list, run here and on device.
 *
 * The point of sharing it: jest proves the shim satisfies every requirement,
 * and the same list runs against the real `crypto.subtle` at app startup, so a
 * gap in `react-native-quick-crypto` shows up as one log line instead of being
 * discovered one failed MLS exchange at a time.
 *
 * Node's WebCrypto is checked too — not because it needs testing, but because
 * a list that nothing can pass would be a silent lie, and this proves the
 * requirements are satisfiable rather than merely strict.
 */
import { webcrypto } from 'node:crypto'
import { makeCurve25519Subtle } from '../../core/crypto/curve25519Subtle'
import { checkWebCrypto, formatConformance } from '../../core/crypto/webCryptoConformance'

const node = webcrypto.subtle as unknown as SubtleCrypto

/**
 * Node's WebCrypto with react-native-quick-crypto 0.7.17's holes punched in it.
 *
 * Testing the shim over a *complete* subtle proves nothing: every gap would be
 * covered by the delegate. Each refusal below is one we have confirmed in that
 * package — the cfrg family commented out of `generateKey`, HMAC importable
 * but unsignable, HKDF not importable at all — so a shim that passes here is
 * one that can stand on the real thing.
 */
function quickCryptoLike(): SubtleCrypto {
  const refuse = (why: string) => {
    throw new Error(why)
  }
  const nameOf = (a: unknown) => (typeof a === 'string' ? a : ((a as { name?: string })?.name ?? ''))
  // A Proxy, not a spread: SubtleCrypto's methods live on its prototype, and
  // spreading it silently drops digest, encrypt and the rest.
  const holes: Record<string, unknown> = {
    generateKey: async (algorithm: AlgorithmIdentifier, extractable: boolean, usages: KeyUsage[]) => {
      const name = nameOf(algorithm)
      if (['Ed25519', 'Ed448', 'X25519', 'X448', 'HMAC'].includes(name)) {
        refuse(`'subtle.generateKey()' is not implemented for ${name}. Unrecognized algorithm name`)
      }
      return await node.generateKey(algorithm as never, extractable, usages)
    },
    importKey: async (
      format: string,
      data: BufferSource | JsonWebKey,
      algorithm: AlgorithmIdentifier,
      extractable: boolean,
      usages: KeyUsage[]
    ) => {
      const name = nameOf(algorithm)
      if (name === 'HKDF') refuse('"subtle.importKey()" is not implemented for HKDF')
      if (['Ed25519', 'X25519'].includes(name)) refuse(`"subtle.importKey()" is not implemented for ${name}`)
      return await node.importKey(format as never, data as never, algorithm as never, extractable, usages)
    },
    sign: async (algorithm: AlgorithmIdentifier, k: CryptoKey, data: BufferSource) => {
      if (['HMAC', 'Ed25519'].includes(nameOf(algorithm))) {
        refuse(`Unrecognized algorithm name '[object Object]' for 'sign'`)
      }
      return await node.sign(algorithm as never, k, data)
    },
    verify: async (algorithm: AlgorithmIdentifier, k: CryptoKey, sig: BufferSource, data: BufferSource) => {
      if (['HMAC', 'Ed25519'].includes(nameOf(algorithm))) {
        refuse(`Unrecognized algorithm name '[object Object]' for 'verify'`)
      }
      return await node.verify(algorithm as never, k, sig, data)
    },
    deriveBits: async (algorithm: Algorithm, k: CryptoKey, length: number) => {
      if (['HKDF', 'X25519'].includes(nameOf(algorithm))) {
        refuse(`'subtle.deriveBits()' is not implemented for ${nameOf(algorithm)}`)
      }
      return await node.deriveBits(algorithm as never, k, length as never)
    }
  }
  return new Proxy(node, {
    get(target, prop, receiver) {
      if (prop in holes) return holes[prop as string]
      const value = Reflect.get(target, prop, receiver) as unknown
      return typeof value === 'function' ? value.bind(target) : value
    }
  }) as unknown as SubtleCrypto
}

describe('the conformance list', () => {
  it('passes against the shim, over a runtime with the same holes', async () => {
    const results = await checkWebCrypto(makeCurve25519Subtle(quickCryptoLike()))

    expect(results.filter(r => !r.ok)).toEqual([])
  })

  it('fails without the shim on that same runtime', async () => {
    // Proof the model above is not vacuous: unshimmed, those holes are fatal.
    const results = await checkWebCrypto(quickCryptoLike())

    expect(results.filter(r => !r.ok).map(r => r.name)).toContain('HKDF: deriveBits')
    expect(results.filter(r => !r.ok).length).toBeGreaterThan(3)
  })

  it('passes against a complete WebCrypto', async () => {
    const results = await checkWebCrypto(node)

    expect(results.filter(r => !r.ok)).toEqual([])
  })

  it('reports every failure, not only the first', async () => {
    // A subtle that refuses everything: a list that stopped at the first error
    // would hide the rest, which is the whole problem it exists to solve.
    const broken = new Proxy(
      {},
      {
        get: () => () => {
          throw new Error('not implemented')
        }
      }
    ) as SubtleCrypto

    const results = await checkWebCrypto(broken)

    expect(results.length).toBeGreaterThan(5)
    expect(results.every(r => !r.ok)).toBe(true)
    expect(results.every(r => r.detail === 'not implemented')).toBe(true)
  })

  it('names what failed, so a device log is actionable', async () => {
    const results = [
      { name: 'HKDF: deriveBits', ok: false, detail: 'not implemented for HKDF' },
      { name: 'SHA-256: digest', ok: true }
    ]

    const text = formatConformance(results)

    expect(text).toContain('1/2 FAILED')
    expect(text).toContain('HKDF: deriveBits')
    expect(text).toContain('not implemented for HKDF')
  })

  it('says so plainly when everything passes', () => {
    expect(formatConformance([{ name: 'a', ok: true }])).toContain('all 1 checks passed')
  })
})
