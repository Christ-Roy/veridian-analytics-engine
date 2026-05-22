import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NotFoundPage, AppErrorPage } from '../error-pages';

/**
 * Tests Vitest pour les pages d'erreur brandées Veridian (ticket U9).
 *
 * NotFoundPage (404) et AppErrorPage (exception) sont branchées sur le
 * routeur via `__root.tsx`. On vérifie le rendu, les libellés français et
 * le lien de retour vers le dashboard.
 */

describe('NotFoundPage', () => {
  it('renders a branded 404 with a home link', () => {
    render(<NotFoundPage />);
    expect(screen.getByTestId('not-found-page')).toBeInTheDocument();
    expect(screen.getByText('Page introuvable')).toBeInTheDocument();
    expect(screen.getByTestId('not-found-home-link')).toHaveAttribute(
      'href',
      '/',
    );
  });

  it('shows a French subtitle (not the raw staminads fallback)', () => {
    render(<NotFoundPage />);
    expect(
      screen.getByText(/n'existe pas ou a été déplacée/i),
    ).toBeInTheDocument();
  });
});

describe('AppErrorPage', () => {
  it('renders a branded error screen', () => {
    render(<AppErrorPage />);
    expect(screen.getByTestId('app-error-page')).toBeInTheDocument();
    expect(screen.getByText('Une erreur est survenue')).toBeInTheDocument();
    expect(
      screen.getByTestId('app-error-home-button'),
    ).toBeInTheDocument();
  });

  it('surfaces the error message when provided', () => {
    render(<AppErrorPage error={new Error('database timeout')} />);
    expect(screen.getByText('database timeout')).toBeInTheDocument();
  });

  it('falls back to a generic French message without an error', () => {
    render(<AppErrorPage />);
    expect(
      screen.getByText(/Quelque chose s'est mal passé/i),
    ).toBeInTheDocument();
  });
});
