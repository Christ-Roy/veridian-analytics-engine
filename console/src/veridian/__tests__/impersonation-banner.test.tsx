import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ImpersonationBanner } from '../impersonation-banner';

describe('ImpersonationBanner', () => {
  it('renders the tenant name and Mode admin label when impersonating', () => {
    render(
      <ImpersonationBanner tenantName="Tramtech" tenantSlug="tramtech" />,
    );
    const banner = screen.getByTestId('impersonation-banner');
    expect(banner).toBeInTheDocument();
    expect(banner).toHaveAttribute('data-tenant-slug', 'tramtech');
    expect(banner).toHaveTextContent('Mode admin');
    expect(banner).toHaveTextContent('Tramtech');
  });

  it('exposes an exit link with the provided exitHref', () => {
    render(
      <ImpersonationBanner
        tenantName="Tramtech"
        tenantSlug="tramtech"
        exitHref="/admin/back"
      />,
    );
    expect(screen.getByTestId('exit-impersonation')).toHaveAttribute(
      'href',
      '/admin/back',
    );
  });

  it('renders nothing when impersonating=false', () => {
    const { container } = render(
      <ImpersonationBanner
        tenantName="Tramtech"
        tenantSlug="tramtech"
        impersonating={false}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
