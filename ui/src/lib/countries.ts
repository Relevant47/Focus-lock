// ISO 3166-1 alpha-2 codes. Names are resolved at runtime via Intl.DisplayNames
// (falls back to the raw code if unavailable), so we only ship the code list.

export const COUNTRY_CODES: string[] = [
  'AF','AX','AL','DZ','AS','AD','AO','AI','AQ','AG','AR','AM','AW','AU','AT','AZ',
  'BS','BH','BD','BB','BY','BE','BZ','BJ','BM','BT','BO','BA','BW','BR','IO','BN',
  'BG','BF','BI','KH','CM','CA','CV','KY','CF','TD','CL','CN','CO','KM','CG','CD',
  'CR','CI','HR','CU','CY','CZ','DK','DJ','DM','DO','EC','EG','SV','GQ','ER','EE',
  'ET','FJ','FI','FR','GF','PF','GA','GM','GE','DE','GH','GI','GR','GL','GD','GP',
  'GU','GT','GN','GW','GY','HT','HN','HK','HU','IS','IN','ID','IR','IQ','IE','IL',
  'IT','JM','JP','JO','KZ','KE','KI','KP','KR','KW','KG','LA','LV','LB','LS','LR',
  'LY','LI','LT','LU','MO','MK','MG','MW','MY','MV','ML','MT','MH','MQ','MR','MU',
  'MX','FM','MD','MC','MN','ME','MS','MA','MZ','MM','NA','NR','NP','NL','NC','NZ',
  'NI','NE','NG','NU','NO','OM','PK','PW','PS','PA','PG','PY','PE','PH','PL','PT',
  'PR','QA','RE','RO','RU','RW','WS','SM','ST','SA','SN','RS','SC','SL','SG','SK',
  'SI','SB','SO','ZA','SS','ES','LK','SD','SR','SZ','SE','CH','SY','TW','TJ','TZ',
  'TH','TL','TG','TO','TT','TN','TR','TM','TC','TV','UG','UA','AE','GB','US','UY',
  'UZ','VU','VA','VE','VN','VG','VI','YE','ZM','ZW',
];

let displayNames: Intl.DisplayNames | null = null;
try {
  displayNames = new Intl.DisplayNames(['en'], { type: 'region' });
} catch {
  displayNames = null;
}

export function countryName(code: string): string {
  try {
    return displayNames?.of(code) ?? code;
  } catch {
    return code;
  }
}

export interface Country { code: string; name: string }

export const COUNTRIES: Country[] = COUNTRY_CODES
  .map((code) => ({ code, name: countryName(code) }))
  .sort((a, b) => a.name.localeCompare(b.name));
