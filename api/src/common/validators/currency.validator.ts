import {
  registerDecorator,
  ValidationOptions,
  ValidationArguments,
} from 'class-validator';

/**
 * ISO 4217 currency codes (active codes, the subset a SaaS realistically bills
 * in). A bare `@IsString() @Length(3,3)` let garbage like "BANANABUCKS" (and
 * even single chars / 20-char strings via the settings path) persist into a
 * workspace — then `Intl.NumberFormat(locale, { style: 'currency', currency })`
 * throws a `RangeError` in the console (real staging gap 2026-06-24).
 *
 * Closed list (not a regex `^[A-Z]{3}$`) so "ZZZ"/"XYZ" are also rejected: the
 * console only ever formats a real currency. Mirrors the `timezone` validator
 * pattern (closed whitelist, single source of truth) so currency and timezone
 * are validated with the same rigor in the same command.
 */
export const ISO_4217_CURRENCY_CODES = new Set<string>([
  'AED', 'AFN', 'ALL', 'AMD', 'ANG', 'AOA', 'ARS', 'AUD', 'AWG', 'AZN',
  'BAM', 'BBD', 'BDT', 'BGN', 'BHD', 'BIF', 'BMD', 'BND', 'BOB', 'BRL',
  'BSD', 'BTN', 'BWP', 'BYN', 'BZD', 'CAD', 'CDF', 'CHF', 'CLP', 'CNY',
  'COP', 'CRC', 'CUP', 'CVE', 'CZK', 'DJF', 'DKK', 'DOP', 'DZD', 'EGP',
  'ERN', 'ETB', 'EUR', 'FJD', 'FKP', 'GBP', 'GEL', 'GHS', 'GIP', 'GMD',
  'GNF', 'GTQ', 'GYD', 'HKD', 'HNL', 'HRK', 'HTG', 'HUF', 'IDR', 'ILS',
  'INR', 'IQD', 'IRR', 'ISK', 'JMD', 'JOD', 'JPY', 'KES', 'KGS', 'KHR',
  'KMF', 'KPW', 'KRW', 'KWD', 'KYD', 'KZT', 'LAK', 'LBP', 'LKR', 'LRD',
  'LSL', 'LYD', 'MAD', 'MDL', 'MGA', 'MKD', 'MMK', 'MNT', 'MOP', 'MRU',
  'MUR', 'MVR', 'MWK', 'MXN', 'MYR', 'MZN', 'NAD', 'NGN', 'NIO', 'NOK',
  'NPR', 'NZD', 'OMR', 'PAB', 'PEN', 'PGK', 'PHP', 'PKR', 'PLN', 'PYG',
  'QAR', 'RON', 'RSD', 'RUB', 'RWF', 'SAR', 'SBD', 'SCR', 'SDG', 'SEK',
  'SGD', 'SHP', 'SLE', 'SOS', 'SRD', 'SSP', 'STN', 'SVC', 'SYP', 'SZL',
  'THB', 'TJS', 'TMT', 'TND', 'TOP', 'TRY', 'TTD', 'TWD', 'TZS', 'UAH',
  'UGX', 'USD', 'UYU', 'UZS', 'VED', 'VES', 'VND', 'VUV', 'WST', 'XAF',
  'XCD', 'XOF', 'XPF', 'YER', 'ZAR', 'ZMW', 'ZWL',
]);

/** True if `value` is a known active ISO-4217 currency code (uppercase). */
export function isIso4217Currency(value: unknown): boolean {
  return typeof value === 'string' && ISO_4217_CURRENCY_CODES.has(value);
}

/**
 * Property decorator rejecting any value that is not an active ISO-4217 currency
 * code. The code MUST be uppercase (`EUR`, not `eur`) — the console & Stripe
 * both expect the canonical uppercase form, so we do not silently up-case here.
 */
export function IsIso4217Currency(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isIso4217Currency',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown) {
          return isIso4217Currency(value);
        },
        defaultMessage(args: ValidationArguments) {
          return `${args.property} must be a valid ISO-4217 currency code (uppercase, e.g. EUR, USD, GBP)`;
        },
      },
    });
  };
}
