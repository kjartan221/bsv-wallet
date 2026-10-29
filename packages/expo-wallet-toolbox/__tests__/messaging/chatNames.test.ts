/**
 * A name this device gives a chat.
 *
 * The library has no rename: a chat's name is whatever the inviter put on the
 * wire, and it is the same for everyone. That is right for a group and wrong
 * for everything else — a 1:1 arrives named after the person reading it, and a
 * group someone else named may mean nothing here.
 *
 * So a local override, in the playground's own database next to the
 * transcript. It never goes on the wire and the other side never sees it.
 *
 * Real SQLite, for the same reason as the transcript: a fake that looks names
 * up in JavaScript cannot tell a working query from a missing WHERE clause.
 */
import { DatabaseSync } from 'node:sqlite'
import { makeChatNames } from '../../core/messaging/chatNames'

function database() {
  const db = new DatabaseSync(':memory:')
  return {
    execAsync: async (sql: string) => db.exec(sql),
    runAsync: async (sql: string, params: unknown[] = []) => {
      db.prepare(sql).run(...(params as never[]))
    },
    getAllAsync: async (sql: string, params: unknown[] = []) => db.prepare(sql).all(...(params as never[]))
  }
}

describe('local chat names', () => {
  it('has no name for a chat nobody renamed', async () => {
    const names = await makeChatNames(database() as never)

    expect(await names.all()).toEqual({})
  })

  it('remembers a name', async () => {
    const names = await makeChatNames(database() as never)

    await names.set('c1', 'Launch crew')

    expect((await names.all())['c1']).toBe('Launch crew')
  })

  it('replaces a name rather than keeping both', async () => {
    const names = await makeChatNames(database() as never)

    await names.set('c1', 'First try')
    await names.set('c1', 'Better name')

    const all = await names.all()
    expect(all['c1']).toBe('Better name')
    expect(Object.keys(all)).toEqual(['c1'])
  })

  it('keeps chats apart', async () => {
    const names = await makeChatNames(database() as never)

    await names.set('c1', 'One')
    await names.set('c2', 'Two')

    expect(await names.all()).toEqual({ c1: 'One', c2: 'Two' })
  })

  it('clearing a name gives the derived one back', async () => {
    const names = await makeChatNames(database() as never)
    await names.set('c1', 'Temporary')

    await names.set('c1', '   ')

    // Blank is not a name; the caller falls back to the other member or the
    // shared one rather than showing an empty row.
    expect(await names.all()).toEqual({})
  })

  it('survives being opened twice over the same database', async () => {
    const db = database()
    await makeChatNames(db as never)
    const second = await makeChatNames(db as never)

    await second.set('c1', 'Still here')
    expect((await second.all())['c1']).toBe('Still here')
  })
})
