import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LockedServicePage } from '../locked-service-page';

describe('LockedServicePage', () => {
  it('renders locked title for the service', () => {
    render(<LockedServicePage service="calls" siteDomain="tramtech.fr" />);
    expect(screen.getByTestId('locked-title')).toHaveTextContent(
      'Appels téléphoniques verrouillés',
    );
  });

  it('exposes locked-page data-testid + CTA mailto', () => {
    render(<LockedServicePage service="gsc" siteDomain="tramtech.fr" />);
    expect(screen.getByTestId('locked-page-gsc')).toBeInTheDocument();
    const cta = screen.getByTestId('locked-cta');
    expect(cta.getAttribute('href') ?? '').toMatch(/^mailto:contact@veridian\.site/);
  });

  it('falls back to a generic siteDomain when empty string passed', () => {
    render(<LockedServicePage service="forms" siteDomain="" />);
    const cta = screen.getByTestId('locked-cta');
    const href = decodeURIComponent(cta.getAttribute('href') ?? '');
    expect(href).toContain('votre-site.fr');
  });
});
