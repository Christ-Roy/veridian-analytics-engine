import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AuthShell } from '../auth-shell';
import { AuthContext, type AuthState } from '../../lib/AuthContext';

/**
 * Tests Vitest pour AuthShell (ticket U9).
 *
 * AuthShell est le chrome commun des pages d'auth. Il switche le logo
 * Veridian vs Staminads selon le flag runtime `isDemo` de `AuthContext`.
 * On vérifie que :
 *   - instance Veridian (isDemo=true)  → logo veridian-logo.svg + alt Veridian
 *   - instance Staminads (isDemo=false) → logo logo.svg + alt Staminads
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

  it('renders the Staminads logo on the internal console (isDemo=false)', () => {
    renderWithAuth(false);
    const logo = screen.getByTestId('auth-logo');
    expect(logo).toHaveAttribute('src', '/logo.svg');
    expect(logo).toHaveAttribute('alt', 'Staminads');
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
