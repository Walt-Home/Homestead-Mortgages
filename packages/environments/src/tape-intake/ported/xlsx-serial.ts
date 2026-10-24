// The one function the m3-v1 profile takes from the vendored workbook reader
// (packages/partner-book/src/vendored/xlsx.ts), copied byte for byte from its
// "Excel serial dates" section, so the profile's port reaches no node:zlib.
// src/__tests__/tape-intake.test.ts holds the text below this comment to that
// section's, character for character.

// ───────── Excel serial dates ─────────
const MS_PER_DAY = 86_400_000;
/**
 * 1900 date system with the Lotus leap-year bug: serial 1 = 1900-01-01,
 * serial 60 = the non-existent 1900-02-29 (tolerated, returned as such),
 * serial 61 = 1900-03-01, 25569 = 1970-01-01, 45920 = 2025-09-20.
 * Fractional serials (a time of day) are truncated to the day.
 */
export function excelSerialToIsoDate(serial: number): string {
  if (!Number.isFinite(serial)) throw new RangeError(`excelSerialToIsoDate: not a serial: ${serial}`);
  const day = Math.floor(serial);
  if (day === 60) return "1900-02-29";
  // 1899-12-30 epoch for serials past the phantom day; 1899-12-31 before it.
  const epoch = day > 60 ? Date.UTC(1899, 11, 30) : Date.UTC(1899, 11, 31);
  const d = new Date(epoch + day * MS_PER_DAY);
  const y = d.getUTCFullYear(); const m = d.getUTCMonth() + 1; const dd = d.getUTCDate();
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
}
