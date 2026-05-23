import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AuthShell } from '../auth-shell';
import { AuthContext, type AuthState } from '../../lib/AuthContext';

/**
 * Tests Vitest pour AuthShell.
 *
 * AuthShell est le chrome commun des pages d'auth. Depuis le fix
 * upstream-branding-cleanup (2026-05-23, BUG-08/09), le branding est figé
 * Veridian sur tous les déploiements — le flag `isDemo` ne pilote plus
 * le logo. On vérifie donc que :
 *   - le logo Veridian est rendu indépendamment de isDemo
 *   - le crédit photo Unsplash est toujours présent
 */

function makeAuthState(isDemo: boolean): AuthState {
  return {
    token: null,
    user: null,
    isAuthenticated: false,
    isLoading: false,
    login: async () => {},
    logout: () => {},
    publicConfig: null,
    isDemo,
  };
}

function renderWithAuth(isDemo: boolean) {
  return render(
    <AuthContext.Provider value={makeAuthState(isDemo)}>
      <AuthShell>
        <div data-testid="auth-child">child</div>
      </AuthShell>
    </AuthContext.Provider>,
  );
}

describe('AuthShell', () => {
  it('renders the Veridian logo on a Veridian instance (isDemo=true)', () => {
    renderWithAuth(true);
    const logo = screen.getByTestId('auth-logo');
    expect(logo).toHaveAttribute('src', '/veridian-logo.svg');
    expect(logo).toHaveAttribute('alt', 'Veridian Analytics');
  });

  it('also renders the Veridian logo on non-demo instances (branding figé Veridian)', () => {
    renderWithAuth(false);
    const logo = screen.getByTestId('auth-logo');
    expect(logo).toHaveAttribute('src', '/veridian-logo.svg');
    expect(logo).toHaveAttribute('alt', 'Veridian Analytics');
  });

  it('renders its children', () => {
    renderWithAuth(true);
    expect(screen.getByTestId('auth-child')).toBeInTheDocument();
  });

  it('always shows the Unsplash photo credit', () => {
    renderWithAuth(true);
    expect(screen.getByText(/Rod Long/)).toBeInTheDocument();
  });
});
