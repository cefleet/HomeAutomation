export type Units = 'F' | 'C';

/** `units` view prop: 'F' default (US), 'C' override. */
export const unitProp = (props?: Record<string, unknown>): Units =>
  props?.units === 'C' ? 'C' : 'F';

/** Contract temperature is canonical °C; convert for display. */
export const toDisplay = (
  tempC: number | undefined,
  units: Units,
): number | undefined =>
  tempC == null ? undefined : Math.round(units === 'F' ? (tempC * 9) / 5 + 32 : tempC);
