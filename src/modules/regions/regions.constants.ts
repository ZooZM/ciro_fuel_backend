import { GovernorateCode, RegionCode } from '../../common/enums/region.enum';

export interface RegionInfo {
  code: RegionCode;
  nameAr: string;
  nameEn: string;
  governorates: GovernorateCode[];
}

export interface GovernorateInfo {
  code: GovernorateCode;
  region: RegionCode;
  nameAr: string;
  nameEn: string;
}

/**
 * The 13 Saudi regions with Arabic/English names (spec 004 FR-010). Order
 * matches the conventional administrative listing. Governorate names are a
 * partial reference set — see the caveat on `GovernorateCode`.
 */
export const REGIONS: readonly RegionInfo[] = [
  {
    code: RegionCode.RIYADH,
    nameAr: 'الرياض',
    nameEn: 'Riyadh',
    governorates: [
      GovernorateCode.RIYADH_CITY,
      GovernorateCode.DIRIYAH,
      GovernorateCode.KHARJ,
      GovernorateCode.DAWADMI,
      GovernorateCode.MAJMAAH,
    ],
  },
  {
    code: RegionCode.MAKKAH,
    nameAr: 'مكة المكرمة',
    nameEn: 'Makkah',
    governorates: [
      GovernorateCode.MAKKAH_CITY,
      GovernorateCode.JEDDAH,
      GovernorateCode.TAIF,
      GovernorateCode.RABIGH,
      GovernorateCode.QUNFUDHAH,
    ],
  },
  {
    code: RegionCode.MADINAH,
    nameAr: 'المدينة المنورة',
    nameEn: 'Madinah',
    governorates: [
      GovernorateCode.MADINAH_CITY,
      GovernorateCode.YANBU,
      GovernorateCode.ALULA,
      GovernorateCode.BADR,
    ],
  },
  {
    code: RegionCode.QASSIM,
    nameAr: 'القصيم',
    nameEn: 'Qassim',
    governorates: [GovernorateCode.BURAYDAH, GovernorateCode.UNAYZAH, GovernorateCode.RASS],
  },
  {
    code: RegionCode.EASTERN_PROVINCE,
    nameAr: 'المنطقة الشرقية',
    nameEn: 'Eastern Province',
    governorates: [
      GovernorateCode.DAMMAM,
      GovernorateCode.DHAHRAN,
      GovernorateCode.KHOBAR,
      GovernorateCode.AHSA,
      GovernorateCode.JUBAIL,
      GovernorateCode.QATIF,
    ],
  },
  {
    code: RegionCode.ASIR,
    nameAr: 'عسير',
    nameEn: 'Asir',
    governorates: [GovernorateCode.ABHA, GovernorateCode.KHAMIS_MUSHAIT, GovernorateCode.BISHA],
  },
  {
    code: RegionCode.TABUK,
    nameAr: 'تبوك',
    nameEn: 'Tabuk',
    governorates: [GovernorateCode.TABUK_CITY, GovernorateCode.DUBA],
  },
  {
    code: RegionCode.HAIL,
    nameAr: 'حائل',
    nameEn: 'Hail',
    governorates: [GovernorateCode.HAIL_CITY],
  },
  {
    code: RegionCode.NORTHERN_BORDERS,
    nameAr: 'الحدود الشمالية',
    nameEn: 'Northern Borders',
    governorates: [GovernorateCode.ARAR, GovernorateCode.RAFHA],
  },
  {
    code: RegionCode.JAZAN,
    nameAr: 'جازان',
    nameEn: 'Jazan',
    governorates: [GovernorateCode.JAZAN_CITY, GovernorateCode.SABYA],
  },
  {
    code: RegionCode.NAJRAN,
    nameAr: 'نجران',
    nameEn: 'Najran',
    governorates: [GovernorateCode.NAJRAN_CITY, GovernorateCode.SHARURAH],
  },
  {
    code: RegionCode.AL_BAHAH,
    nameAr: 'الباحة',
    nameEn: 'Al Bahah',
    governorates: [GovernorateCode.AL_BAHAH_CITY],
  },
  {
    code: RegionCode.AL_JOUF,
    nameAr: 'الجوف',
    nameEn: 'Al Jouf',
    governorates: [GovernorateCode.SAKAKA, GovernorateCode.QURAYYAT],
  },
] as const;

const GOVERNORATE_NAMES: Record<GovernorateCode, { ar: string; en: string }> = {
  [GovernorateCode.RIYADH_CITY]: { ar: 'الرياض', en: 'Riyadh' },
  [GovernorateCode.DIRIYAH]: { ar: 'الدرعية', en: 'Diriyah' },
  [GovernorateCode.KHARJ]: { ar: 'الخرج', en: 'Al-Kharj' },
  [GovernorateCode.DAWADMI]: { ar: 'الدوادمي', en: 'Al-Dawadmi' },
  [GovernorateCode.MAJMAAH]: { ar: 'المجمعة', en: "Al-Majma'ah" },
  [GovernorateCode.MAKKAH_CITY]: { ar: 'مكة المكرمة', en: 'Makkah' },
  [GovernorateCode.JEDDAH]: { ar: 'جدة', en: 'Jeddah' },
  [GovernorateCode.TAIF]: { ar: 'الطائف', en: 'Taif' },
  [GovernorateCode.RABIGH]: { ar: 'رابغ', en: 'Rabigh' },
  [GovernorateCode.QUNFUDHAH]: { ar: 'القنفذة', en: 'Al-Qunfudhah' },
  [GovernorateCode.MADINAH_CITY]: { ar: 'المدينة المنورة', en: 'Madinah' },
  [GovernorateCode.YANBU]: { ar: 'ينبع', en: 'Yanbu' },
  [GovernorateCode.ALULA]: { ar: 'العلا', en: 'AlUla' },
  [GovernorateCode.BADR]: { ar: 'بدر', en: 'Badr' },
  [GovernorateCode.BURAYDAH]: { ar: 'بريدة', en: 'Buraydah' },
  [GovernorateCode.UNAYZAH]: { ar: 'عنيزة', en: 'Unaizah' },
  [GovernorateCode.RASS]: { ar: 'الرس', en: 'Ar Rass' },
  [GovernorateCode.DAMMAM]: { ar: 'الدمام', en: 'Dammam' },
  [GovernorateCode.DHAHRAN]: { ar: 'الظهران', en: 'Dhahran' },
  [GovernorateCode.KHOBAR]: { ar: 'الخبر', en: 'Al Khobar' },
  [GovernorateCode.AHSA]: { ar: 'الأحساء', en: 'Al-Ahsa' },
  [GovernorateCode.JUBAIL]: { ar: 'الجبيل', en: 'Jubail' },
  [GovernorateCode.QATIF]: { ar: 'القطيف', en: 'Qatif' },
  [GovernorateCode.ABHA]: { ar: 'أبها', en: 'Abha' },
  [GovernorateCode.KHAMIS_MUSHAIT]: { ar: 'خميس مشيط', en: 'Khamis Mushait' },
  [GovernorateCode.BISHA]: { ar: 'بيشة', en: 'Bisha' },
  [GovernorateCode.TABUK_CITY]: { ar: 'تبوك', en: 'Tabuk' },
  [GovernorateCode.DUBA]: { ar: 'ضباء', en: 'Duba' },
  [GovernorateCode.HAIL_CITY]: { ar: 'حائل', en: 'Hail' },
  [GovernorateCode.ARAR]: { ar: 'عرعر', en: 'Arar' },
  [GovernorateCode.RAFHA]: { ar: 'رفحاء', en: 'Rafha' },
  [GovernorateCode.JAZAN_CITY]: { ar: 'جازان', en: 'Jazan' },
  [GovernorateCode.SABYA]: { ar: 'صبيا', en: 'Sabya' },
  [GovernorateCode.NAJRAN_CITY]: { ar: 'نجران', en: 'Najran' },
  [GovernorateCode.SHARURAH]: { ar: 'شرورة', en: 'Sharurah' },
  [GovernorateCode.AL_BAHAH_CITY]: { ar: 'الباحة', en: 'Al Bahah' },
  [GovernorateCode.SAKAKA]: { ar: 'سكاكا', en: 'Sakaka' },
  [GovernorateCode.QURAYYAT]: { ar: 'القريات', en: 'Qurayyat' },
};

/** Flat lookup: every governorate with its parent region resolved. */
export const GOVERNORATES: readonly GovernorateInfo[] = REGIONS.flatMap((region) =>
  region.governorates.map((code) => ({
    code,
    region: region.code,
    nameAr: GOVERNORATE_NAMES[code].ar,
    nameEn: GOVERNORATE_NAMES[code].en,
  })),
);

const REGION_BY_CODE = new Map(REGIONS.map((r) => [r.code, r]));
const GOVERNORATE_BY_CODE = new Map(GOVERNORATES.map((g) => [g.code, g]));

export function isValidRegionCode(code: string): code is RegionCode {
  return REGION_BY_CODE.has(code as RegionCode);
}

export function isValidGovernorateCode(code: string): code is GovernorateCode {
  return GOVERNORATE_BY_CODE.has(code as GovernorateCode);
}

/** True when the governorate genuinely belongs to the given region. */
export function governorateBelongsToRegion(
  governorate: GovernorateCode,
  region: RegionCode,
): boolean {
  return GOVERNORATE_BY_CODE.get(governorate)?.region === region;
}
