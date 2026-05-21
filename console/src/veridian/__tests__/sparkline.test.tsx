import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Sparkline } from '../sparkline';

describe('Sparkline', () => {
  it('renders an SVG with two paths when data is provided', () => {
    render(
      <Sparkline
        data={[
          { day: '2026-05-15', value: 5 },
          { day: '2026-05-16', value: 10 },
          { day: '2026-05-17', value: 7 },
        ]}
        positive
      />,
    );
    const svg = screen.getByTestId('sparkline-svg');
    expect(svg.tagName.toLowerCase()).toBe('svg');
    expect(svg.querySelectorAll('path').length).toBe(2);
    expect(svg.querySelectorAll('circle').length).toBe(1);
  });

  it('falls back to an empty placeholder when no data', () => {
    render(<Sparkline data={[]} />);
    expect(screen.getByTestId('sparkline-empty')).toBeInTheDocument();
  });

  it('uses the rose color when positive=false', () => {
    const { container } = render(
      <Sparkline
        data={[
          { day: 'a', value: 5 },
          { day: 'b', value: 1 },
        ]}
        positive={false}
      />,
    );
    const strokePath = container.querySelector('path[stroke]');
    expect(strokePath?.getAttribute('stroke')).toBe('#fb7185');
    const circle = container.querySelector('circle');
    expect(circle?.getAttribute('fill')).toBe('#fb7185');
  });
});
