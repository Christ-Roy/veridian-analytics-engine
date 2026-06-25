import { getDefaultFilters } from './default-filters';
import {
  VALID_SOURCE_FIELDS,
  VALID_WRITABLE_DIMENSIONS,
} from '../../filters/entities/filter.entity';

describe('getDefaultFilters', () => {
  it('returns an array of filters', () => {
    const filters = getDefaultFilters();

    expect(Array.isArray(filters)).toBe(true);
    expect(filters.length).toBeGreaterThan(0);
  });

  it('returns approximately 40 filters', () => {
    const filters = getDefaultFilters();

    // 10 click ID + 7 UTM paid + 1 referrer paid + 1 referral interne + 2 direct
    // + 7 search organic + 10 social organic + 1 email + 1 default = 40
    expect(filters.length).toBe(40);
  });

  it('generates unique IDs for each filter', () => {
    const filters = getDefaultFilters();
    const ids = filters.map((f) => f.id);
    const uniqueIds = new Set(ids);

    expect(uniqueIds.size).toBe(filters.length);
  });

  it('generates new IDs on each call', () => {
    const filters1 = getDefaultFilters();
    const filters2 = getDefaultFilters();

    // IDs should be different between calls
    expect(filters1[0].id).not.toBe(filters2[0].id);
  });

  it('all filters have valid source fields in conditions', () => {
    const filters = getDefaultFilters();

    for (const filter of filters) {
      for (const condition of filter.conditions) {
        expect(VALID_SOURCE_FIELDS.has(condition.field)).toBe(true);
      }
    }
  });

  it('all filters have valid writable dimensions in operations', () => {
    const filters = getDefaultFilters();

    for (const filter of filters) {
      for (const operation of filter.operations) {
        expect(VALID_WRITABLE_DIMENSIONS.has(operation.dimension)).toBe(true);
      }
    }
  });

  it('all filters have unique order values', () => {
    const filters = getDefaultFilters();
    const orders = filters.map((f) => f.order);
    const uniqueOrders = new Set(orders);

    expect(uniqueOrders.size).toBe(filters.length);
  });

  it('filters are ordered sequentially from 1', () => {
    const filters = getDefaultFilters();
    const orders = filters.map((f) => f.order).sort((a, b) => a - b);

    expect(orders[0]).toBe(1);
    expect(orders[orders.length - 1]).toBe(filters.length);
  });

  it('click ID filters have highest priority (900-831)', () => {
    const filters = getDefaultFilters();
    const clickIdFilters = filters.filter((f) => f.name.includes('Click ID'));

    expect(clickIdFilters.length).toBe(10);
    for (const filter of clickIdFilters) {
      expect(filter.priority).toBeGreaterThanOrEqual(831);
      expect(filter.priority).toBeLessThanOrEqual(900);
    }
  });

  it('default fallback filter has lowest priority (10)', () => {
    const filters = getDefaultFilters();
    const defaultFilter = filters.find((f) => f.name === 'Default Channel');

    expect(defaultFilter).toBeDefined();
    expect(defaultFilter!.priority).toBe(10);
  });

  it('default fallback filter uses set_default_value action', () => {
    const filters = getDefaultFilters();
    const defaultFilter = filters.find((f) => f.name === 'Default Channel');

    expect(defaultFilter).toBeDefined();
    for (const operation of defaultFilter!.operations) {
      expect(operation.action).toBe('set_default_value');
    }
  });

  it('all filters have a computed version hash', () => {
    const filters = getDefaultFilters();

    for (const filter of filters) {
      expect(filter.version).toBeDefined();
      expect(typeof filter.version).toBe('string');
      expect(filter.version.length).toBeGreaterThan(0);
    }
  });

  it('all filters share the same version hash', () => {
    const filters = getDefaultFilters();
    const versions = new Set(filters.map((f) => f.version));

    expect(versions.size).toBe(1);
  });

  it('all filters are enabled by default', () => {
    const filters = getDefaultFilters();

    for (const filter of filters) {
      expect(filter.enabled).toBe(true);
    }
  });

  it('all channel filters have the "channel" tag', () => {
    const filters = getDefaultFilters();
    const channelFilters = filters.filter((f) => f.name !== 'Default Channel');

    for (const filter of channelFilters) {
      expect(filter.tags).toContain('channel');
    }
  });

  it('default filter has the "default" tag', () => {
    const filters = getDefaultFilters();
    const defaultFilter = filters.find((f) => f.name === 'Default Channel');

    expect(defaultFilter!.tags).toContain('default');
  });

  it('includes expected paid channels', () => {
    const filters = getDefaultFilters();
    const paidChannels = [
      'google-ads',
      'facebook-ads',
      'microsoft-ads',
      'tiktok-ads',
      'pinterest-ads',
      'linkedin-ads',
      'twitter-ads',
      'instagram-ads',
      'youtube-ads',
      'snapchat-ads',
      'reddit-ads',
      'quora-ads',
    ];

    for (const channel of paidChannels) {
      const hasChannel = filters.some((f) =>
        f.operations.some((op) => op.value === channel),
      );
      expect(hasChannel).toBe(true);
    }
  });

  it('includes expected organic channels', () => {
    const filters = getDefaultFilters();
    const organicChannels = [
      'google-organic',
      'bing-organic',
      'yahoo-organic',
      'duckduckgo-organic',
      'baidu-organic',
      'yandex-organic',
      'facebook-organic',
      'instagram-organic',
      'twitter-organic',
      'linkedin-organic',
      'youtube-organic',
      'tiktok-organic',
      'pinterest-organic',
      'reddit-organic',
      'snapchat-organic',
      'quora-organic',
    ];

    for (const channel of organicChannels) {
      const hasChannel = filters.some((f) =>
        f.operations.some((op) => op.value === channel),
      );
      expect(hasChannel).toBe(true);
    }
  });

  it('includes direct and email channels', () => {
    const filters = getDefaultFilters();

    const hasDirectChannel = filters.some((f) =>
      f.operations.some((op) => op.value === 'direct'),
    );
    const hasEmailChannel = filters.some((f) =>
      f.operations.some((op) => op.value === 'email'),
    );

    expect(hasDirectChannel).toBe(true);
    expect(hasEmailChannel).toBe(true);
  });

  // S6 Lot B — le filtre referral interne doit primer sur Direct Traffic, sinon
  // un parrainage ?ref= (is_direct + utm_content) retombe en `direct`.
  describe('Referral interne (?ref=) — S6 Lot B', () => {
    it('exists, sets channel/channel_group=referral, prime sur Direct Traffic', () => {
      const filters = getDefaultFilters();
      const ref = filters.find((f) => f.name === 'Referral interne (?ref=)');
      const direct = filters.find((f) => f.name === 'Direct Traffic');

      expect(ref).toBeDefined();
      expect(direct).toBeDefined();
      // Priorité STRICTEMENT supérieure → le set_value referral gagne sur direct.
      expect(ref!.priority).toBeGreaterThan(direct!.priority);
      // Conditions ANDées : is_direct=true ET utm_content non vide (= code parrain).
      expect(ref!.conditions).toEqual(
        expect.arrayContaining([
          { field: 'is_direct', operator: 'equals', value: 'true' },
          { field: 'utm_content', operator: 'regex', value: '.+' },
        ]),
      );
      expect(ref!.operations).toEqual(
        expect.arrayContaining([
          { dimension: 'channel_group', action: 'set_value', value: 'referral' },
          { dimension: 'channel', action: 'set_value', value: 'referral' },
        ]),
      );
    });

    it('reste SOUS les sources plus riches (ads/organic) — zéro régression', () => {
      const filters = getDefaultFilters();
      const ref = filters.find((f) => f.name === 'Referral interne (?ref=)')!;
      // Toutes les sources riches PAR REFERRER/UTM-PAYANT (ads click-id, organic
      // search/social) ont priorité > ref → un ?ref= qui s'ajoute à un vrai canal
      // ne le masque jamais (ces sources ont un referrer/utm, donc is_direct=false
      // ET priorité supérieure : double garde-fou). NB : Email (300) est déjà sous
      // les filtres is_direct (740) dans CETTE taxonomie ; on n'aggrave rien.
      const richer = filters.filter(
        (f) => f.name.includes('Ads') || f.name.includes('Organic'),
      );
      expect(richer.length).toBeGreaterThan(0);
      for (const f of richer) {
        expect(f.priority).toBeGreaterThan(ref.priority);
      }
    });
  });
});
