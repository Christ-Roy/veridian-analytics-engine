import {
  registerDecorator,
  ValidationOptions,
  ValidationArguments,
} from 'class-validator';

/**
 * Default bounds for free-form string maps coming from the public track
 * endpoint (`properties` of a goal, `dimensions` of a session).
 *
 * Ticket ingest-properties-dimensions-non-bornees 2026-06-23 : sans bornes,
 * un client peut envoyer un objet de 10 000 clés ou des valeurs de plusieurs
 * Ko, écrits tels quels en ClickHouse et propagés aux webhooks/Twenty. Le cap
 * body Express (100kb) devenait l'unique rempart — fragile.
 */
export const MAX_MAP_KEYS = 50;
export const MAX_MAP_KEY_LENGTH = 256;
export const MAX_MAP_VALUE_LENGTH = 1024;

export interface BoundedStringMapOptions {
  maxKeys?: number;
  maxKeyLength?: number;
  maxValueLength?: number;
}

/**
 * Valide qu'une valeur est un objet « plat » (Record<string, string-ish>)
 * borné : nombre de clés, longueur des clés et des valeurs plafonnés, AUCUNE
 * imbrication (pas d'objet/array en valeur → coupe la profondeur et les
 * payloads en arbre). Les valeurs scalaires non-string (number/boolean) sont
 * tolérées tant qu'une fois converties en string elles respectent la borne de
 * longueur — l'écriture ClickHouse les sérialise de toute façon.
 *
 * Rejette (validation 400) au lieu de tronquer silencieusement : un payload
 * hors bornes est anormal, mieux vaut un échec explicite côté SDK.
 */
export function IsBoundedStringMap(
  options?: BoundedStringMapOptions,
  validationOptions?: ValidationOptions,
) {
  const maxKeys = options?.maxKeys ?? MAX_MAP_KEYS;
  const maxKeyLength = options?.maxKeyLength ?? MAX_MAP_KEY_LENGTH;
  const maxValueLength = options?.maxValueLength ?? MAX_MAP_VALUE_LENGTH;

  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isBoundedStringMap',
      target: object.constructor,
      propertyName: propertyName,
      options: validationOptions,
      constraints: [maxKeys, maxKeyLength, maxValueLength],
      validator: {
        validate(value: unknown): boolean {
          // Optional fields: undefined/null is fine (use @IsOptional alongside).
          if (value === undefined || value === null) return true;

          // Must be a plain object (not array, not primitive).
          if (typeof value !== 'object' || Array.isArray(value)) return false;

          const entries = Object.entries(value as Record<string, unknown>);

          if (entries.length > maxKeys) return false;

          for (const [key, val] of entries) {
            if (key.length > maxKeyLength) return false;

            // Reject nesting (objects/arrays) → bounds depth + tree payloads.
            if (val !== null && typeof val === 'object') return false;

            // Scalars: bound their string representation length.
            if (val !== null && val !== undefined) {
              const asString = typeof val === 'string' ? val : String(val);
              if (asString.length > maxValueLength) return false;
            }
          }

          return true;
        },
        defaultMessage(args: ValidationArguments): string {
          const [k, kl, vl] = args.constraints as [number, number, number];
          return (
            `${args.property} must be a flat object with at most ${k} keys, ` +
            `keys <= ${kl} chars, values <= ${vl} chars, and no nesting`
          );
        },
      },
    });
  };
}
