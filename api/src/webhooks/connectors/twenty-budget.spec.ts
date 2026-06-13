import { TwentyBudget } from './twenty-budget';

describe('TwentyBudget', () => {
  it('grants tokens up to the per-minute limit', () => {
    const budget = new TwentyBudget(3, () => 0);
    expect(budget.take()).toBe(true);
    expect(budget.take()).toBe(true);
    expect(budget.take()).toBe(true);
    expect(budget.take()).toBe(false);
  });

  it('resets the bucket after a full minute', () => {
    let clock = 0;
    const budget = new TwentyBudget(1, () => clock);
    expect(budget.take()).toBe(true);
    expect(budget.take()).toBe(false);
    clock = 60_000;
    expect(budget.take()).toBe(true);
  });

  it('does not reset before the minute is up', () => {
    let clock = 0;
    const budget = new TwentyBudget(1, () => clock);
    expect(budget.take()).toBe(true);
    clock = 59_999;
    expect(budget.take()).toBe(false);
  });

  it('reports remaining tokens', () => {
    let clock = 0;
    const budget = new TwentyBudget(2, () => clock);
    expect(budget.remaining()).toBe(2);
    budget.take();
    expect(budget.remaining()).toBe(1);
    clock = 60_000;
    expect(budget.remaining()).toBe(2);
  });
});
