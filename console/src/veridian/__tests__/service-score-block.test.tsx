import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ServiceScoreBlock } from '../service-score-block';

describe('ServiceScoreBlock', () => {
  it('renders metric value formatted in fr-FR', () => {
    render(
      <ServiceScoreBlock
        service="pageviews"
        metric={{ value: 1234, previous: 1000, deltaPct: 23.4 }}
      />,
    );
    // 1234 formatted with fr-FR Intl => '1 234' (NBSP-narrow)
    const valueEl = screen.getByTestId('service-pageviews-value');
    expect(valueEl.textContent?.replace(/\s/g, '')).toBe('1234');
  });

  it('renders 0 score with negative delta', () => {
    render(
      <ServiceScoreBlock
        service="forms"
        metric={{ value: 0, previous: 10, deltaPct: -100 }}
      />,
    );
    expect(screen.getByTestId('service-forms-value')).toHaveTextContent('0');
    expect(screen.getByTestId('service-forms-delta')).toHaveTextContent('-100');
  });

  it('renders score 50 with positive trend label', () => {
    render(
      <ServiceScoreBlock
        service="calls"
        metric={{ value: 50, previous: 25, deltaPct: 100 }}
      />,
    );
    const delta = screen.getByTestId('service-calls-delta');
    expect(delta.textContent).toMatch(/\+100/);
  });

  it('renders score 90 with sparkline when data passed', () => {
    render(
      <ServiceScoreBlock
        service="gsc"
        metric={{
          value: 90,
          previous: 80,
          deltaPct: 12.5,
          sparkline: [
            { day: '2026-05-15', value: 10 },
            { day: '2026-05-16', value: 20 },
            { day: '2026-05-17', value: 30 },
          ],
        }}
      />,
    );
    expect(screen.getByTestId('service-gsc-value')).toHaveTextContent('90');
    expect(screen.getByTestId('sparkline-svg')).toBeInTheDocument();
  });

  it('uses default href from SERVICE_META and exposes data-service', () => {
    render(
      <ServiceScoreBlock
        service="push"
        metric={{ value: 5, previous: 5, deltaPct: 0 }}
      />,
    );
    const link = screen.getByTestId('service-push');
    expect(link).toHaveAttribute('href', '/dashboard/push');
    expect(link).toHaveAttribute('data-service', 'push');
  });
});
