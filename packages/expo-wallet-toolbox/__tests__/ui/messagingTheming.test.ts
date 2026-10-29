/**
 * The messaging screens have to work in both themes.
 *
 * Every colour has to come from the palette, which defines a light and a dark
 * value for each token. A literal passes review in whichever mode the author
 * happened to be in and is wrong in the other — and `accent` is a trap of its
 * own: it is `black` in light and `white` in dark, so it is right for the one
 * primary button on a screen and wrong for a surface, which is how the chat
 * bubbles ended up as black slabs in light mode.
 *
 * Read as source rather than rendered: a snapshot would only show one theme,
 * which is the problem.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SCREENS = ['MessagingThreadScreen.tsx', 'MessagingPlaygroundScreen.tsx']

function source(name: string): string {
  return readFileSync(join(__dirname, '..', '..', 'ui', 'screens', name), 'utf8')
}

/** Lines that set a colour to something other than a palette token. */
function colourLiterals(text: string): string[] {
  return text
    .split(/\r?\n/)
    .filter(line => /(?:color|Color|backgroundColor|borderColor|tintColor)\s*[:=]/.test(line))
    .filter(line => /#[0-9a-fA-F]{3,8}\b|['"](?:black|white|red|blue|green|grey|gray)['"]/.test(line))
    .map(line => line.trim())
}

describe('messaging screens in both themes', () => {
  it.each(SCREENS)('%s takes every colour from the palette', name => {
    expect(colourLiterals(source(name))).toEqual([])
  })

  it('does not paint a message bubble with the CTA accent', () => {
    // `accent` is black in light and white in dark. On a button that is the
    // point — it is the Pay pill. On a bubble it is a slab, and it collides
    // with every other primary action on the screen.
    const offending = source('MessagingThreadScreen.tsx')
      .split(/\r?\n/)
      .filter(line => line.includes('styles.bubble') || line.includes('bubble.mine ?'))
      .filter(line => line.includes('colors.accent'))
      .map(line => line.trim())

    expect(offending).toEqual([])
  })

  it('catches a literal when one is introduced', () => {
    // Proof the matcher bites, so an empty result means clean rather than
    // broken.
    expect(colourLiterals("  const s = { backgroundColor: '#FF0000' }")).toHaveLength(1)
    expect(colourLiterals("  <Icon color={'black'} />")).toHaveLength(1)
    expect(colourLiterals('  const s = { backgroundColor: colors.fill }')).toHaveLength(0)
  })
})
