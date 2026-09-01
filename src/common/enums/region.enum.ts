/**
 * Saudi Arabia's 13 administrative regions (المناطق الإدارية). Referenced by
 * code everywhere — routing (spec 004 FR-014), the client station form, and
 * Transportation Company region assignment — never as free text (Principle I).
 */
export enum RegionCode {
  RIYADH = 'RIYADH',
  MAKKAH = 'MAKKAH',
  MADINAH = 'MADINAH',
  QASSIM = 'QASSIM',
  EASTERN_PROVINCE = 'EASTERN_PROVINCE',
  ASIR = 'ASIR',
  TABUK = 'TABUK',
  HAIL = 'HAIL',
  NORTHERN_BORDERS = 'NORTHERN_BORDERS',
  JAZAN = 'JAZAN',
  NAJRAN = 'NAJRAN',
  AL_BAHAH = 'AL_BAHAH',
  AL_JOUF = 'AL_JOUF',
}

/**
 * Governorates (محافظات) within each region. This is display/UX data for the
 * client station form (spec 004 FR-009/FR-011) — routing (FR-014) resolves
 * on `RegionCode` alone, never governorate, so an incomplete or imprecise
 * governorate list cannot affect order routing correctness.
 *
 * The set below covers the major/well-known governorate of each region and
 * is NOT claimed to be exhaustive — several regions have additional smaller
 * governorates not listed here. Verify and complete this list against an
 * authoritative source (e.g. the General Authority for Statistics) before
 * treating it as a complete reference; until then, treat gaps here as a
 * known limitation, not a bug in the routing logic that depends on it.
 */
export enum GovernorateCode {
  // Riyadh
  RIYADH_CITY = 'RIYADH_CITY',
  DIRIYAH = 'DIRIYAH',
  KHARJ = 'KHARJ',
  DAWADMI = 'DAWADMI',
  MAJMAAH = 'MAJMAAH',
  // Makkah
  MAKKAH_CITY = 'MAKKAH_CITY',
  JEDDAH = 'JEDDAH',
  TAIF = 'TAIF',
  RABIGH = 'RABIGH',
  QUNFUDHAH = 'QUNFUDHAH',
  // Madinah
  MADINAH_CITY = 'MADINAH_CITY',
  YANBU = 'YANBU',
  ALULA = 'ALULA',
  BADR = 'BADR',
  // Qassim
  BURAYDAH = 'BURAYDAH',
  UNAYZAH = 'UNAYZAH',
  RASS = 'RASS',
  // Eastern Province
  DAMMAM = 'DAMMAM',
  DHAHRAN = 'DHAHRAN',
  KHOBAR = 'KHOBAR',
  AHSA = 'AHSA',
  JUBAIL = 'JUBAIL',
  QATIF = 'QATIF',
  // Asir
  ABHA = 'ABHA',
  KHAMIS_MUSHAIT = 'KHAMIS_MUSHAIT',
  BISHA = 'BISHA',
  // Tabuk
  TABUK_CITY = 'TABUK_CITY',
  DUBA = 'DUBA',
  // Hail
  HAIL_CITY = 'HAIL_CITY',
  // Northern Borders
  ARAR = 'ARAR',
  RAFHA = 'RAFHA',
  // Jazan
  JAZAN_CITY = 'JAZAN_CITY',
  SABYA = 'SABYA',
  // Najran
  NAJRAN_CITY = 'NAJRAN_CITY',
  SHARURAH = 'SHARURAH',
  // Al Bahah
  AL_BAHAH_CITY = 'AL_BAHAH_CITY',
  // Al Jouf
  SAKAKA = 'SAKAKA',
  QURAYYAT = 'QURAYYAT',
}
