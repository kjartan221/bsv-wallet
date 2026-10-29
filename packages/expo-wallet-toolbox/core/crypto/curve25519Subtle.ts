/**
 * Ed25519 and X25519 for `crypto.subtle`, on top of `@noble/curves`.
 *
 * `react-native-quick-crypto@0.7.17` installs a `subtle` whose `generateKey`
 * has the whole cfrg family commented out — `cfrgGenerateKey` is defined
 * nowhere in the package — so Ed25519 and X25519 throw on device. That would be
 * survivable if the libraries fell back, but they do the opposite: `ts-mls`
 * takes the WebCrypto path for Ed25519 *because* `globalThis.crypto.subtle`
 * exists and only reaches for `@noble/curves` when there is none, and hpke's
 * X25519 KEM is WebCrypto-only. A half-implemented `subtle` is worse than no
 * `subtle` at all.
 *
 * So this fills in exactly the two algorithms that are missing and hands
 * everything else to the implementation underneath. The primitives are noble's;
 * what is written here is the WebCrypto shape around them — key objects, DER
 * and JWK — which is why the tests check every format against a real WebCrypto
 * rather than only against itself.
 *
 * Keys are plain objects, not `CryptoKey` instances. Nothing in the MLS stack
 * asserts `instanceof CryptoKey`: hpke's own `isCryptoKeyPair` is a duck-type
 * check and it ships an `XCryptoKey` of its own for the same reason.
 *
 * Base64url is hand-rolled rather than going through `btoa`/`atob`. Hermes'
 * `atob` is strict, and quick-crypto's own JWK export — standard base64 with a
 * stray `.` in it — is the bug that exposed all of this.
 */
import { ed25519, x25519 } from '@noble/curves/ed25519.js'
import { hmac } from '@noble/hashes/hmac.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256, sha384, sha512 } from '@noble/hashes/sha2.js'

type CurveName = 'Ed25519' | 'X25519'
type ShimName = CurveName | 'HMAC' | 'HKDF'

interface CurveKey {
  type: 'public' | 'private' | 'secret'
  extractable: boolean
  algorithm: { name: ShimName; hash?: { name: string } }
  usages: KeyUsage[]
  bytes: Uint8Array
}

/**
 * HMAC is here for the same reason the curves are: quick-crypto imports the
 * key and then leaves `sign` and `verify` commented out, so hpke's HKDF and
 * ts-mls's own MAC both fail on it.
 */
type NobleHash = Parameters<typeof hmac>[0]

const HASHES: Record<string, NobleHash> = {
  'SHA-256': sha256,
  'SHA-384': sha384,
  'SHA-512': sha512
}

const CURVES: CurveName[] = ['Ed25519', 'X25519']

/** RFC 8410 object identifiers, as they appear inside the DER. */
const OID = { X25519: 0x6e, Ed25519: 0x70 } as const

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

function toBase64Url(input: Uint8Array): string {
  let out = ''
  for (let i = 0; i < input.length; i += 3) {
    const a = input[i]
    const b = input[i + 1]
    const c = input[i + 2]
    out += B64URL[a >> 2]
    out += B64URL[((a & 3) << 4) | ((b ?? 0) >> 4)]
    if (b === undefined) break
    out += B64URL[((b & 15) << 2) | ((c ?? 0) >> 6)]
    if (c === undefined) break
    out += B64URL[c & 63]
  }
  return out
}

function fromBase64Url(input: string): Uint8Array {
  const out: number[] = []
  let buffer = 0
  let bits = 0
  for (const ch of input) {
    const value = B64URL.indexOf(ch)
    if (value < 0) continue
    buffer = (buffer << 6) | value
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out.push((buffer >> bits) & 0xff)
    }
  }
  return new Uint8Array(out)
}

function nameOf(algorithm: AlgorithmIdentifier | { name?: string }): string {
  return typeof algorithm === 'string' ? algorithm : (algorithm?.name ?? '')
}

function isCurve(algorithm: unknown): algorithm is CurveName {
  return CURVES.includes(nameOf(algorithm as AlgorithmIdentifier) as CurveName)
}

function isHmac(algorithm: unknown): boolean {
  return nameOf(algorithm as AlgorithmIdentifier) === 'HMAC'
}

function isHkdf(algorithm: unknown): boolean {
  return nameOf(algorithm as AlgorithmIdentifier) === 'HKDF'
}

function hashNamed(name: string): NobleHash {
  const hash = HASHES[name]
  if (hash === undefined) throw new Error(`Unsupported hash: ${name}`)
  return hash
}

function hashOf(key: CurveKey): NobleHash {
  return hashNamed(key.algorithm.hash?.name ?? 'SHA-256')
}

/** Length-safe comparison, so a tag check does not leak where it diverged. */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

function asBytes(data: BufferSource): Uint8Array {
  if (data instanceof Uint8Array) return data
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  return new Uint8Array(data)
}

/** A copy, so a caller mutating the result cannot reach back into the key. */
function toBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer
}

function key(type: CurveKey['type'], name: CurveName, bytes: Uint8Array, usages: KeyUsage[]): CurveKey {
  return { type, extractable: true, algorithm: { name }, usages, bytes }
}

/**
 * PKCS#8 for a 32-byte seed, per RFC 8410 §7: the private key is an OCTET
 * STRING holding another OCTET STRING. The lengths are fixed at this size, so
 * the prefix is a constant rather than a general-purpose DER encoder.
 */
function toPkcs8(name: CurveName, seed: Uint8Array): Uint8Array {
  return new Uint8Array([
    0x30,
    0x2e,
    0x02,
    0x01,
    0x00,
    0x30,
    0x05,
    0x06,
    0x03,
    0x2b,
    0x65,
    OID[name],
    0x04,
    0x22,
    0x04,
    0x20,
    ...seed
  ])
}

function fromPkcs8(name: CurveName, der: Uint8Array): Uint8Array {
  if (der.length < 34) throw new Error(`Invalid ${name} pkcs8 key`)
  // The OID byte distinguishes the two curves; refusing a mismatch here stops
  // an X25519 key being used as an Ed25519 one by accident.
  const oid = der[11]
  if (oid !== OID[name]) throw new Error(`pkcs8 key is not ${name}`)
  const seed = der.slice(der.length - 32)
  if (seed.length !== 32) throw new Error(`Invalid ${name} pkcs8 key`)
  return seed
}

function publicOf(name: CurveName, seed: Uint8Array): Uint8Array {
  return name === 'Ed25519' ? ed25519.getPublicKey(seed) : x25519.getPublicKey(seed)
}

/**
 * Wrap a `SubtleCrypto` so Ed25519 and X25519 work, passing everything else
 * through untouched.
 */
export function makeCurve25519Subtle(delegate: SubtleCrypto): SubtleCrypto {
  const shim = {
    async generateKey(algorithm: AlgorithmIdentifier, extractable: boolean, usages: KeyUsage[]) {
      if (isHmac(algorithm)) {
        const hash = { name: nameOf((algorithm as { hash?: AlgorithmIdentifier }).hash ?? 'SHA-256') }
        const secret = new Uint8Array(hashOf({ algorithm: { name: 'HMAC', hash } } as CurveKey).outputLen)
        globalThis.crypto.getRandomValues(secret)
        return { type: 'secret', extractable, algorithm: { name: 'HMAC', hash }, usages, bytes: secret }
      }
      if (!isCurve(algorithm)) return await delegate.generateKey(algorithm as never, extractable, usages)
      const name = nameOf(algorithm) as CurveName
      const seed = name === 'Ed25519' ? ed25519.utils.randomSecretKey() : x25519.utils.randomSecretKey()
      const privateUsages = name === 'Ed25519' ? (['sign'] as KeyUsage[]) : (['deriveBits', 'deriveKey'] as KeyUsage[])
      return {
        privateKey: key(
          'private',
          name,
          seed,
          usages.filter(u => privateUsages.includes(u))
        ),
        publicKey: key(
          'public',
          name,
          publicOf(name, seed),
          usages.filter(u => u === 'verify')
        )
      }
    },

    async importKey(
      format: string,
      data: BufferSource | JsonWebKey,
      algorithm: AlgorithmIdentifier,
      extractable: boolean,
      usages: KeyUsage[]
    ) {
      if (isHkdf(algorithm)) {
        if (format !== 'raw') throw new Error(`Unsupported HKDF key format: ${format}`)
        return {
          type: 'secret',
          extractable,
          algorithm: { name: 'HKDF' },
          usages,
          bytes: asBytes(data as BufferSource).slice()
        }
      }
      if (isHmac(algorithm)) {
        if (format !== 'raw') throw new Error(`Unsupported HMAC key format: ${format}`)
        const hash = { name: nameOf((algorithm as { hash?: AlgorithmIdentifier }).hash ?? 'SHA-256') }
        return {
          type: 'secret',
          extractable,
          algorithm: { name: 'HMAC', hash },
          usages,
          bytes: asBytes(data as BufferSource).slice()
        }
      }
      if (!isCurve(algorithm)) {
        return await delegate.importKey(format as never, data as never, algorithm as never, extractable, usages)
      }
      const name = nameOf(algorithm) as CurveName
      if (format === 'jwk') {
        const jwk = data as JsonWebKey
        if (jwk.kty !== 'OKP' || jwk.crv !== name) throw new Error(`Invalid ${name} jwk`)
        if (typeof jwk.d === 'string') return key('private', name, fromBase64Url(jwk.d), usages)
        if (typeof jwk.x !== 'string') throw new Error(`Invalid ${name} jwk`)
        return key('public', name, fromBase64Url(jwk.x), usages)
      }
      const bytes = asBytes(data as BufferSource)
      if (format === 'pkcs8') return key('private', name, fromPkcs8(name, bytes), usages)
      if (format === 'raw') return key('public', name, bytes.slice(), usages)
      throw new Error(`Unsupported ${name} key format: ${format}`)
    },

    async exportKey(format: string, cryptoKey: CryptoKey) {
      const k = cryptoKey as unknown as CurveKey
      if (isHmac(k?.algorithm)) {
        if (format !== 'raw') throw new Error(`Unsupported HMAC key format: ${format}`)
        return toBuffer(k.bytes)
      }
      if (!isCurve(k?.algorithm)) return await delegate.exportKey(format as never, cryptoKey)
      const name = k.algorithm.name as CurveName
      if (format === 'raw') {
        if (k.type !== 'public') throw new Error('Only a public key can be exported as raw')
        return toBuffer(k.bytes)
      }
      if (format === 'pkcs8') {
        if (k.type !== 'private') throw new Error('Only a private key can be exported as pkcs8')
        return toBuffer(toPkcs8(name, k.bytes))
      }
      if (format === 'jwk') {
        const isPrivate = k.type === 'private'
        const pub = isPrivate ? publicOf(name, k.bytes) : k.bytes
        return {
          kty: 'OKP',
          crv: name,
          x: toBase64Url(pub),
          ...(isPrivate ? { d: toBase64Url(k.bytes) } : {}),
          key_ops: [...k.usages],
          ext: true
        } as JsonWebKey
      }
      throw new Error(`Unsupported ${name} key format: ${format}`)
    },

    async sign(algorithm: AlgorithmIdentifier, cryptoKey: CryptoKey, data: BufferSource) {
      const k = cryptoKey as unknown as CurveKey
      if (isHmac(algorithm) || isHmac(k?.algorithm)) {
        return toBuffer(hmac(hashOf(k), k.bytes, asBytes(data)))
      }
      if (!isCurve(algorithm) && !isCurve(k?.algorithm)) {
        return await delegate.sign(algorithm as never, cryptoKey, data)
      }
      return toBuffer(ed25519.sign(asBytes(data), k.bytes))
    },

    async verify(algorithm: AlgorithmIdentifier, cryptoKey: CryptoKey, signature: BufferSource, data: BufferSource) {
      const k = cryptoKey as unknown as CurveKey
      if (isHmac(algorithm) || isHmac(k?.algorithm)) {
        return sameBytes(hmac(hashOf(k), k.bytes, asBytes(data)), asBytes(signature))
      }
      if (!isCurve(algorithm) && !isCurve(k?.algorithm)) {
        return await delegate.verify(algorithm as never, cryptoKey, signature, data)
      }
      try {
        return ed25519.verify(asBytes(signature), asBytes(data), k.bytes)
      } catch {
        // A malformed signature is a false, not a throw — WebCrypto's contract.
        return false
      }
    },

    async deriveBits(algorithm: Algorithm & { public?: CryptoKey }, cryptoKey: CryptoKey, length: number | null) {
      const k = cryptoKey as unknown as CurveKey
      if (!isCurve(algorithm) && !isCurve(k?.algorithm) && !isHkdf(algorithm) && !isHkdf(k?.algorithm)) {
        return await delegate.deriveBits(algorithm as never, cryptoKey, length as never)
      }
      if (isHkdf(algorithm) || isHkdf(k?.algorithm)) {
        const params = algorithm as unknown as { hash?: AlgorithmIdentifier; salt?: BufferSource; info?: BufferSource }
        if (length === null || length === undefined) throw new Error('HKDF needs a length')
        const derived = hkdf(
          hashNamed(nameOf(params.hash ?? 'SHA-256')),
          k.bytes,
          params.salt === undefined ? new Uint8Array() : asBytes(params.salt),
          params.info === undefined ? new Uint8Array() : asBytes(params.info),
          length / 8
        )
        return toBuffer(derived)
      }
      const peer = algorithm.public as unknown as CurveKey | undefined
      if (peer === undefined) throw new Error('X25519 deriveBits needs a public key')
      const shared = x25519.getSharedSecret(k.bytes, peer.bytes)
      if (length !== null && length !== undefined && length !== shared.length * 8) {
        throw new Error(`X25519 derives ${shared.length * 8} bits, not ${length}`)
      }
      return toBuffer(shared)
    }
  }

  // Everything not named above — digest, encrypt, decrypt, wrapKey and the
  // rest — stays whatever it already was.
  return new Proxy(delegate, {
    get(target, prop, receiver) {
      if (prop in shim) return (shim as Record<string, unknown>)[prop as string]
      const value = Reflect.get(target, prop, receiver) as unknown
      return typeof value === 'function' ? value.bind(target) : value
    }
  }) as SubtleCrypto
}

/**
 * Install the shim over `globalThis.crypto.subtle`.
 *
 * Must run *after* `QuickCrypto.install()`, which replaces `globalThis.crypto`
 * wholesale — that is how the same kind of polyfill was silently lost in
 * solana-web3.js#2898 — and before anything reads `subtle`, because hpke caches
 * it per instance.
 */
export function installCurve25519Subtle(): boolean {
  const existing = globalThis.crypto?.subtle
  if (existing === undefined) return false
  const patched = makeCurve25519Subtle(existing)
  try {
    Object.defineProperty(globalThis.crypto, 'subtle', { value: patched, configurable: true })
    return true
  } catch {
    return false
  }
}
