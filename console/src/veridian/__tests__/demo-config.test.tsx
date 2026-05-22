import { describe, it, expect } from 'vitest'
import { demoContactMailto, type PublicConfig } from '../../lib/demo-config'

const CFG: PublicConfig = {
  is_demo: true,
  demo_workspace_id: 'demo-apple',
  contact_email: 'robert.brunon@veridian.site',
}

describe('demoContactMailto', () => {
  it('builds a mailto link to the configured contact email', () => {
    const link = demoContactMailto(CFG)
    expect(link.startsWith('mailto:robert.brunon@veridian.site')).toBe(true)
  })

  it('URL-encodes the subject and body', () => {
    const link = demoContactMailto(CFG)
    expect(link).toContain('subject=')
    expect(link).toContain('body=')
    // Spaces must be encoded, never raw.
    expect(link).not.toContain(' ')
  })

  it('uses a custom contact email when provided', () => {
    const link = demoContactMailto({ ...CFG, contact_email: 'sales@veridian.site' })
    expect(link.startsWith('mailto:sales@veridian.site')).toBe(true)
  })
})
