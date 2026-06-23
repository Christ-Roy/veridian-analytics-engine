import {
  registerDecorator,
  ValidationOptions,
  ValidationArguments,
} from 'class-validator';
import { isValidOrderDirection } from '../utils/order-direction.util';

/**
 * Property decorator for an order map (`Record<string, 'asc' | 'desc'>`).
 * Rejects the whole map (400) if it is not a plain object, or if ANY value is
 * not a valid order direction. Closes the runtime gap left by `@IsObject()`
 * alone, which let `{ "sessions": "ASC, (SELECT ...)" }` through.
 *
 * Backed by the shared `isValidOrderDirection` util (single source of truth,
 * also used by the query-builder defense-in-depth normalization).
 */
export function IsOrderDirectionMap(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isOrderDirectionMap',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown) {
          if (
            typeof value !== 'object' ||
            value === null ||
            Array.isArray(value)
          ) {
            return false;
          }
          return Object.values(value as Record<string, unknown>).every(
            isValidOrderDirection,
          );
        },
        defaultMessage(args: ValidationArguments) {
          return `${args.property} values must each be 'asc' or 'desc'`;
        },
      },
    });
  };
}
