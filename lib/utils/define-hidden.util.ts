/**
 * Defines a read-only, non-enumerable property: readable, but left out by
 * `util.inspect`, `JSON.stringify` and log serializers. Error fields that can
 * carry secrets or personal data (`url`, `headers`, `body`) use it.
 */
export function defineHidden(
  target: object,
  key: string,
  value: unknown,
): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: false,
    writable: false,
    configurable: true,
  });
}
