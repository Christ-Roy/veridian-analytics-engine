import {
  registerDecorator,
  ValidationOptions,
  ValidationArguments,
} from 'class-validator';

/**
 * Phone-number validation for the M2M surface — a SINGLE contract shared by
 * `tenants.provision` (PhoneNumberDto) and `voip.addPhoneNumber`
 * (VoipAddPhoneNumberDto). Before this, the two diverged (provision:
 * `@Length(8,20)`; addPhoneNumber: `@MaxLength(32) @IsNotEmpty`), so the SAME
 * number could be accepted by one route and rejected by the other (ticket
 * 2026-06-24-set-routes-shape-incoherent-e164-divergent).
 *
 * IMPORTANT — this is intentionally NOT a strict E.164 `+<digits>` check. The
 * VoIP service (`phone-e164.ts::toE164`) AUTO-NORMALISES French formats to
 * E.164 before storage: `0612345678` → `+33612345678`, `00…` → `+…`, 9-digit FR
 * → `+33…`. Forcing a leading `+` at the DTO layer would reject those valid
 * inputs and break the documented FR auto-normalisation. So this validator
 * accepts exactly the set of shapes `toE164` can normalise — it is the single
 * "is this a phone number we can store" gate, mirroring the service's own
 * normalisation rules (the service still re-runs toE164 and is the final word).
 *
 * Accepted (after stripping spaces/dots/dashes/parens, like toE164 does):
 *   • `+<6..15 digits>`   (already E.164)
 *   • `00<6..15 digits>`  (international prefix)
 *   • `0<9 digits>`       (FR national, 10 digits total)
 *   • `<9 digits, no leading 0>` (FR without leading 0)
 *
 * Rejected: empty, letters, fantasy length, anything toE164 returns null for.
 */
const E164_ACCEPTED = [
  /^\+\d{6,15}$/, // already E.164
  /^00\d{6,15}$/, // 00 international prefix
  /^0\d{9}$/, // FR national (10 digits)
  /^[1-9]\d{8}$/, // FR without leading 0 (9 digits)
];

/** True if `value`, once cleaned, is a normalisable phone number (see toE164). */
export function isNormalisablePhoneNumber(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const cleaned = value.replace(/[\s.\-()]/g, '').trim();
  if (cleaned.length === 0) return false;
  return E164_ACCEPTED.some((re) => re.test(cleaned));
}

/**
 * Property decorator rejecting any value the VoIP layer could not normalise to
 * E.164. Single shared contract for every phone-number field on the M2M surface.
 */
export function IsE164(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isE164',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown) {
          return isNormalisablePhoneNumber(value);
        },
        defaultMessage(args: ValidationArguments) {
          return `${args.property} must be a phone number in E.164 (+33…) or a normalisable French format (0… / 00…)`;
        },
      },
    });
  };
}
