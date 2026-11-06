import clearNight from '../../assets/weather/clear-night.png';
import clear from '../../assets/weather/clear.png';
import cloudy from '../../assets/weather/cloudy.png';
import fog from '../../assets/weather/fog.png';
import humidity from '../../assets/weather/humidity.png';
import overcast from '../../assets/weather/overcast.png';
import partly from '../../assets/weather/partly.png';
import precip from '../../assets/weather/precip.png';
import rain from '../../assets/weather/rain.png';
import sleet from '../../assets/weather/sleet.png';
import snow from '../../assets/weather/snow.png';
import storm from '../../assets/weather/storm.png';
import tornado from '../../assets/weather/tornado.png';
import wind from '../../assets/weather/wind.png';

export const weatherAssets = { humidity, precip, wind };

/** Conditions text → bundled Flaticon icon. Keywords are checked in
 *  order; the first match wins, so specific terms come before generic
 *  ones ("thunder" before "rain"). */
const RULES: [RegExp, string][] = [
  [/tornado|hurricane|cyclone/i, tornado],
  [/thunder|storm|lightning/i, storm],
  [/sleet|freez|ice|wintry/i, sleet],
  [/snow|blizzard|flurr/i, snow],
  [/fog|mist|haze|smoke/i, fog],
  [/rain|shower|drizzle/i, rain],
  [/wind|breez|bluster/i, wind],
  [/overcast|mostly cloudy/i, overcast],
  [/partly|mostly sunny/i, partly],
  [/cloud/i, cloudy],
  [/sun|clear|fair/i, clear],
  [/night|tonight|moon/i, clearNight],
];

/** Map a conditions/forecast summary string to a bundled weather icon;
 *  unmapped text falls back to the plain cloud icon. */
export function weatherIcon(text?: string): string {
  if (!text) return cloudy;
  for (const [re, icon] of RULES) if (re.test(text)) return icon;
  return cloudy;
}
