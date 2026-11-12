# Recipe Unit Converter

A library for converting recipe quantities between units, with lazily loaded converter plugins, an audit trail, and a recipe scaler.

## Converter Registry

R1. The registry loads a converter plugin by category name only on the first request for that category. Valid categories are exactly "volume", "mass" and "temperature". A plugin is loaded at most once; later requests for the same category return the same loaded plugin without reloading. Requesting a category that has not been used yet must not load any other category.

R2. Requesting a category outside the three valid names (for example "length", or "Volume" with a capital letter) fails with the error `UnknownCategory`, with the message `Unknown category: <name>` where `<name>` is the requested text exactly as given. Nothing is loaded.

## Unit Conversion

R3. The volume plugin supports the units "ml", "l", "tsp", "tbsp", "cup". Using these fixed ratios: 1 l = 1000 ml, 1 cup = 240 ml, 1 tbsp = 15 ml, 1 tsp = 5 ml. Results are rounded to 2 decimal places, half away from zero. Example: 2 cup to ml = 480.00; 1 tsp to l = 0.01 (0.005 rounds up).

R4. The mass plugin supports "g", "kg", "oz", "lb". Ratios: 1 kg = 1000 g, 1 lb = 453.6 g, 1 oz = 28.35 g. Results are rounded to 1 decimal place, half away from zero. Example: 1 lb to oz = 16.0 (453.6 / 28.35 = 16.0).

R5. The temperature plugin supports "C" and "F" and handles two distinct input classes. Absolute temperatures (the default) use F = C × 9/5 + 32 and the inverse. Temperature differences, when the request is flagged as a "delta", use only the scale factor 9/5 or 5/9 with no offset. Both are rounded to the nearest whole number, half away from zero. Examples: absolute 100 C to F = 212; delta 10 C to F = 18. Absolute zero is the lower bound for absolute inputs: a value below -273.15 C or -459.67 F fails with `BelowAbsoluteZero`. Deltas have no lower bound.

R6. Converting between units that belong to different categories, or using a unit the plugin does not support, fails with `UnsupportedUnit` and the message `Unsupported unit: <unit>`, naming the first offending unit (source checked before target). Unit names are case-sensitive.

R7. A quantity that is negative (except temperature, per R5), not a finite number, or missing fails with `InvalidQuantity` and the message `Invalid quantity`. Zero is valid and converts to 0.

## Audit Log

R8. Every successful conversion sends exactly one entry to the external log sink, containing the category, source unit, target unit, input quantity, rounded result, and a timestamp supplied by the sink's own clock. Failed conversions send no entry. The audit component only calls the sink and keeps no copy of entries.

R9. If the log sink raises an error, the conversion still returns its result to the caller, and the audit component reports the failure by returning a warning `AuditWriteFailed` alongside the result. It never retries.

## Recipe Scaler

R10. The scaler takes a list of ingredients (name, quantity, unit), a positive scale factor, and a target system, either "metric" or "imperial". The multiplier is applied first, then each ingredient is converted, so only the final result is rounded per R3 and R4. A scale factor of zero or less fails with `InvalidScale` and the message `Scale must be greater than zero`.

R11. Target system "metric" converts volumes to ml and masses to g. Target system "imperial" converts volumes to cup and masses to oz. Ingredients whose unit is already in the target system's unit are scaled but not converted. Example: 2 lb flour scaled by 0.5 with target metric gives 453.6 g. Any other target system name fails with `UnknownSystem`. An ingredient whose unit is unsupported fails the whole call with `UnsupportedUnit` and no partial result is returned.

R12. Each conversion performed by the scaler goes through the registry and therefore the audit log, producing one log entry per converted ingredient and none for ingredients that needed no conversion.
