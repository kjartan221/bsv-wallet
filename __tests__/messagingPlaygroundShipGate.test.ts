/**
 * Messaging playground ship gate.
 *
 * The playground exercises `@bsv/group-messaging` end to end against a real
 * relay: invite a contact, exchange a KeyPackage, join a Welcome, send MLS
 * messages. It is a test surface, not a product one.
 *
 * Off in production, and deliberately so. Live delivery needs a relay that
 * serves WebSockets and carries the HTTP-send announcement from ts-stack#739.
 * `messagebox.bsvblockchain.tech` (this wallet's payment default) is the Go
 * server, which implements no WebSockets at all; `message-box-us-1.bsvb.tech`
 * is the TypeScript one, and it runs the fix only once bsva-infra-flux moves
 * its pin from v1.1.21 to v1.1.56. Until that lands the playground would show
 * a socket that never connects, so production stays off.
 *
 * Same rule as the Vault gate: changing the set is a deliberate act. Update
 * eas.json and this test together, and say in the PR why.
 */
import easJson from '../eas.json'

type Profile = { env?: Record<string, string> }
const profiles = easJson.build as Record<string, Profile>

describe('Messaging playground ship gate', () => {
  it('the production profile does not enable the playground', () => {
    expect(profiles.production.env?.EXPO_PUBLIC_MESSAGING_PLAYGROUND).toBeUndefined()
  })

  it('only the development profiles enable it', () => {
    const enabled = Object.entries(profiles)
      .filter(([, p]) => p.env?.EXPO_PUBLIC_MESSAGING_PLAYGROUND === 'true')
      .map(([name]) => name)
      .sort()
    expect(enabled).toEqual(['dev-physical', 'development'])
  })
})
