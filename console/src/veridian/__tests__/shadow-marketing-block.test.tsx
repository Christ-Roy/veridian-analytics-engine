import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ShadowMarketingBlock } from '../shadow-marketing-block';
import { SHADOW_MARKETING } from '../types';

describe('ShadowMarketingBlock', () => {
  it('renders title and CTA label from SHADOW_MARKETING table', () => {
    render(<ShadowMarketingBlock service="calls" siteDomain="tramtech.fr" />);
    expect(
      screen.getByText(SHADOW_MARKETING.calls.title),
    ).toBeInTheDocument();
    expect(
      screen.getByText(SHADOW_MARKETING.calls.ctaLabel),
    ).toBeInTheDocument();
  });

  it('builds a mailto: href with subject + body containing the site domain', () => {
    render(<ShadowMarketingBlock service="gsc" siteDomain="tramtech.fr" />);
    const link = screen.getByTestId('shadow-gsc');
    const href = link.getAttribute('href') ?? '';
    expect(href.startsWith('mailto:contact@veridian.site')).toBe(true);
    expect(href).toContain(encodeURIComponent('Veridian Analytics — brancher Google Search Console'));
    expect(decodeURIComponent(href)).toContain('tramtech.fr');
  });
});
