import {
  registerDecorator,
  ValidationOptions,
  ValidationArguments,
} from 'class-validator';
import { isValidTimezone } from '../utils/timezone.util';

/**
 * Property decorator rejecting any value that is not a valid IANA timezone
 * identifier. Backed by the shared `isValidTimezone` util (single source of
 * truth, also used by the analytics query-builder defense-in-depth guard).
 *
 * This is the first of three layers protecting against ClickHouse SQL
 * injection through the `timezone` field (OWASP A03). A bare `@IsString()`
 * would let "UTC') OR 1=1 -- " through; this whitelist rejects it (400).
 */
export function IsIanaTimezone(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isIanaTimezone',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown) {
          return isValidTimezone(value);
        },
        defaultMessage(args: ValidationArguments) {
          return `${args.property} must be a valid IANA timezone identifier`;
        },
      },
    });
  };
}
