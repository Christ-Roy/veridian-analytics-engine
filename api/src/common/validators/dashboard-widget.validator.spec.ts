import {
  validateWidgetConfig,
  validateWidgetsArray,
  isKnownDashboardWidget,
  MAX_CUSTOM_WIDGETS,
} from './dashboard-widget.validator';

/**
 * Sabotage-first tests for the custom widget config validator (garde-fou lead
 * 2026-06-26). A widget that violates the whitelist or the kind coherence rules
 * MUST produce errors so the service maps it to a 400 and never persists it.
 */
describe('dashboard-widget.validator — custom widget config', () => {
  const validMetricCard = {
    id: 'visites-30j',
    kind: 'metric_card',
    title: 'Visites (30j)',
    metric: 'sessions',
  };

  const validDimensionTable = {
    id: 'canaux',
    kind: 'dimension_table',
    title: 'Canaux',
    metric: 'sessions',
    dimension: 'channel_group',
  };

  const validTimeSeries = {
    id: 'visites-jour',
    kind: 'time_series',
    title: 'Visites par jour',
    metric: 'sessions',
    granularity: 'day',
  };

  describe('valid widgets', () => {
    it('accepts a well-formed metric_card', () => {
      expect(validateWidgetConfig(validMetricCard)).toEqual([]);
    });
    it('accepts a well-formed dimension_table', () => {
      expect(validateWidgetConfig(validDimensionTable)).toEqual([]);
    });
    it('accepts a well-formed time_series', () => {
      expect(validateWidgetConfig(validTimeSeries)).toEqual([]);
    });
    it('accepts a pages-table widget with a pages metric/dimension', () => {
      expect(
        validateWidgetConfig({
          id: 'top-pages',
          kind: 'dimension_table',
          title: 'Top pages',
          metric: 'page_count',
          table: 'pages',
          dimension: 'page_path',
          limit: 20,
        }),
      ).toEqual([]);
    });
    it('accepts widget-safe filters', () => {
      expect(
        validateWidgetConfig({
          ...validDimensionTable,
          filters: [{ dimension: 'device', operator: 'equals', values: ['mobile'] }],
        }),
      ).toEqual([]);
    });
    it('accepts a value-less operator (isNotNull) without values', () => {
      expect(
        validateWidgetConfig({
          ...validDimensionTable,
          filters: [{ dimension: 'utm_source', operator: 'isNotNull' }],
        }),
      ).toEqual([]);
    });
  });

  describe('SABOTAGE — the 4 mandated cases', () => {
    it('metric inconnu → erreur', () => {
      const errs = validateWidgetConfig({
        ...validMetricCard,
        metric: 'definitely_not_a_metric',
      });
      expect(errs.some((e) => e.includes('widget.metric'))).toBe(true);
    });

    it('dimension sur metric_card → erreur', () => {
      const errs = validateWidgetConfig({
        ...validMetricCard,
        dimension: 'channel_group',
      });
      expect(
        errs.some((e) => e.includes('widget.dimension must be omitted')),
      ).toBe(true);
    });

    it('time_series sans granularity → erreur', () => {
      const { granularity, ...noGran } = validTimeSeries;
      void granularity;
      const errs = validateWidgetConfig(noGran);
      expect(
        errs.some((e) => e.includes("granularity is required for kind 'time_series'")),
      ).toBe(true);
    });

    it('id dupliqué → erreur (array-level)', () => {
      const errs = validateWidgetsArray([
        validMetricCard,
        { ...validDimensionTable, id: validMetricCard.id },
      ]);
      expect(errs.some((e) => e.includes('duplicate widget id'))).toBe(true);
    });
  });

  describe('more whitelist / coherence rejections', () => {
    it('rejects an excluded identifier dimension (user_id)', () => {
      const errs = validateWidgetConfig({
        ...validDimensionTable,
        dimension: 'user_id',
      });
      expect(errs.some((e) => e.includes("'user_id'"))).toBe(true);
    });

    it('rejects visitor_id / fingerprint as dimensions (not in whitelist)', () => {
      for (const dim of ['visitor_id', 'fingerprint']) {
        const errs = validateWidgetConfig({ ...validDimensionTable, dimension: dim });
        expect(errs.length).toBeGreaterThan(0);
      }
    });

    it('rejects dimension_table without a dimension', () => {
      const { dimension, ...noDim } = validDimensionTable;
      void dimension;
      const errs = validateWidgetConfig(noDim);
      expect(
        errs.some((e) => e.includes("dimension is required for kind 'dimension_table'")),
      ).toBe(true);
    });

    it('rejects an unknown kind', () => {
      const errs = validateWidgetConfig({ ...validMetricCard, kind: 'pie_chart' });
      expect(errs.some((e) => e.includes('widget.kind'))).toBe(true);
    });

    it('rejects an invalid slug id', () => {
      for (const bad of ['', 'Has Spaces', 'UPPER', 'trailing-', 'a'.repeat(65)]) {
        const errs = validateWidgetConfig({ ...validMetricCard, id: bad });
        expect(errs.some((e) => e.includes('widget.id'))).toBe(true);
      }
    });

    it('rejects a metric not available on the chosen table', () => {
      // `goals` metric lives on the goals table — invalid on sessions.
      const errs = validateWidgetConfig({
        ...validMetricCard,
        table: 'sessions',
        metric: 'goals',
      });
      expect(errs.some((e) => e.includes("widget.metric 'goals'"))).toBe(true);
    });

    it('rejects a dimension not available on the chosen table', () => {
      // page_path is a pages-only dimension.
      const errs = validateWidgetConfig({
        id: 'x',
        kind: 'dimension_table',
        title: 'X',
        metric: 'sessions',
        table: 'sessions',
        dimension: 'page_path',
      });
      expect(errs.some((e) => e.includes("widget.dimension 'page_path'"))).toBe(true);
    });

    it('rejects a filter on a non-whitelisted dimension', () => {
      const errs = validateWidgetConfig({
        ...validDimensionTable,
        filters: [{ dimension: 'user_id', operator: 'equals', values: ['x'] }],
      });
      expect(errs.some((e) => e.includes('filters[0].dimension'))).toBe(true);
    });

    it('rejects a value-bearing operator with no values', () => {
      const errs = validateWidgetConfig({
        ...validDimensionTable,
        filters: [{ dimension: 'device', operator: 'equals' }],
      });
      expect(errs.some((e) => e.includes('filters[0].values'))).toBe(true);
    });

    it('rejects an out-of-range limit', () => {
      expect(
        validateWidgetConfig({ ...validDimensionTable, limit: 0 }).length,
      ).toBeGreaterThan(0);
      expect(
        validateWidgetConfig({ ...validDimensionTable, limit: 5000 }).length,
      ).toBeGreaterThan(0);
    });
  });

  // Root-cause of the "Pages les plus consultées" breakage (lead 2026-06-28):
  // a custom widget {table:'pages', metric:'pageviews'} was persisted by
  // setLayout then exploded at widgetData with the runtime 400 "Metric pageviews
  // is not available for table pages". pageviews is a SESSIONS metric. The fix
  // crosses metric×table / dimension×table against the AUTHORITATIVE
  // METRICS/DIMENSIONS constants (the same source the runtime query-builder
  // uses), so an incoherent widget is rejected at PERSIST, never at runtime.
  describe('AUTHORITATIVE table-availability (root-cause: pages/pageviews)', () => {
    it("THE BUG — {table:'pages', metric:'pageviews'} → rejected at persist", () => {
      const errs = validateWidgetConfig({
        id: 'pages-vues',
        kind: 'dimension_table',
        title: 'Pages les plus consultées',
        metric: 'pageviews',
        table: 'pages',
        dimension: 'page_path',
      });
      // pageviews is not a pages metric → must be rejected here, not at runtime.
      expect(
        errs.some(
          (e) =>
            e.includes("widget.metric 'pageviews'") &&
            e.includes("table 'pages'"),
        ),
      ).toBe(true);
      // the actionable message lists the metrics actually valid for `pages`.
      expect(errs.some((e) => e.includes('page_count'))).toBe(true);
    });

    it("THE FIX — {table:'pages', metric:'page_count', dimension:'page_path'} → OK", () => {
      expect(
        validateWidgetConfig({
          id: 'pages-vues',
          kind: 'dimension_table',
          title: 'Pages les plus consultées',
          metric: 'page_count',
          table: 'pages',
          dimension: 'page_path',
        }),
      ).toEqual([]);
    });

    it("native {table:'sessions', metric:'sessions', dimension:'channel_group'} → OK", () => {
      expect(
        validateWidgetConfig({
          id: 'canaux',
          kind: 'dimension_table',
          title: 'Canaux',
          metric: 'sessions',
          table: 'sessions',
          dimension: 'channel_group',
        }),
      ).toEqual([]);
    });

    it('dimension incompatible with table → rejected (page_path on sessions)', () => {
      const errs = validateWidgetConfig({
        id: 'x',
        kind: 'dimension_table',
        title: 'X',
        metric: 'sessions',
        table: 'sessions',
        dimension: 'page_path',
      });
      expect(
        errs.some(
          (e) =>
            e.includes("widget.dimension 'page_path'") &&
            e.includes("table 'sessions'"),
        ),
      ).toBe(true);
    });

    it('filter dimension off-table → rejected (page_path filter on sessions)', () => {
      const errs = validateWidgetConfig({
        id: 'y',
        kind: 'dimension_table',
        title: 'Y',
        metric: 'sessions',
        table: 'sessions',
        dimension: 'channel_group',
        filters: [{ dimension: 'page_path', operator: 'equals', values: ['/'] }],
      });
      expect(errs.some((e) => e.includes('filters[0].dimension'))).toBe(true);
    });

    it('goals metric on sessions table → rejected (cross-table guard holds)', () => {
      const errs = validateWidgetConfig({
        id: 'g',
        kind: 'metric_card',
        title: 'G',
        metric: 'sum_goal_value',
        table: 'sessions',
      });
      expect(
        errs.some((e) => e.includes("widget.metric 'sum_goal_value'")),
      ).toBe(true);
    });
  });

  describe('validateWidgetsArray', () => {
    it('accepts an empty/absent widgets list', () => {
      expect(validateWidgetsArray(undefined)).toEqual([]);
      expect(validateWidgetsArray([])).toEqual([]);
    });
    it('rejects a non-array', () => {
      expect(validateWidgetsArray({} as never).length).toBeGreaterThan(0);
    });
    it('rejects more than MAX_CUSTOM_WIDGETS', () => {
      const many = Array.from({ length: MAX_CUSTOM_WIDGETS + 1 }, (_, i) => ({
        ...validMetricCard,
        id: `w-${i}`,
      }));
      expect(
        validateWidgetsArray(many).some((e) => e.includes('must not exceed')),
      ).toBe(true);
    });
    it('prefixes per-widget errors with the index', () => {
      const errs = validateWidgetsArray([{ ...validMetricCard, metric: 'nope' }]);
      expect(errs.some((e) => e.startsWith('widgets[0]:'))).toBe(true);
    });
  });

  describe('native widget keys (unchanged)', () => {
    it('still recognises the 8 native keys', () => {
      for (const k of [
        'pages',
        'sources',
        'campaigns',
        'countries',
        'heatmap',
        'devices',
        'page_views',
        'goals',
      ]) {
        expect(isKnownDashboardWidget(k)).toBe(true);
      }
      expect(isKnownDashboardWidget('not_native')).toBe(false);
    });
  });
});
