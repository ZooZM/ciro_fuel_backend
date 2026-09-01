import {
  cardUidLookupCandidates,
  normalizeCardUid,
  reverseCardUidBytes,
} from '../../src/common/utils/card-uid.util';

/**
 * The property under test is the one spec 008 assumed and did not have: the
 * same physical card, read by the transporter's desk reader and by the
 * driver's phone, must resolve to the same truck. Everything below is a
 * rendering disagreement seen from readers of this class.
 */
describe('card uid normalization', () => {
  describe('normalizeCardUid', () => {
    it('strips separators and uppercases', () => {
      expect(normalizeCardUid('04:a2:b3:c4')).toBe('04A2B3C4');
      expect(normalizeCardUid('04-A2-B3-C4')).toBe('04A2B3C4');
      expect(normalizeCardUid(' 04 a2 b3 c4 ')).toBe('04A2B3C4');
      expect(normalizeCardUid('04a2b3c4')).toBe('04A2B3C4');
    });

    it('converts a 10-digit decimal reading to hex', () => {
      // 0x04A2B3C4 === 77771716, zero-padded to the 10 digits these readers emit.
      expect(normalizeCardUid('0077771716')).toBe('04A2B3C4');
    });

    it('reads an 8-digit all-numeric value as hex, not decimal', () => {
      // The ambiguous case, resolved by length: 8 characters is the width of a
      // 4-byte hex UID, so this is hex that happens to contain no letters.
      // Reading it as decimal would silently map it to a different card.
      expect(normalizeCardUid('04291623')).toBe('04291623');
    });

    it('leaves a 7-byte UID untouched apart from case and separators', () => {
      expect(normalizeCardUid('04:1a:2b:3c:4d:5e:6f')).toBe('041A2B3C4D5E6F');
    });

    it('returns empty for input with nothing usable in it', () => {
      expect(normalizeCardUid('')).toBe('');
      expect(normalizeCardUid('   ')).toBe('');
      expect(normalizeCardUid(':::')).toBe('');
    });
  });

  describe('reverseCardUidBytes', () => {
    it('reverses byte order, not character order', () => {
      expect(reverseCardUidBytes('04A2B3C4')).toBe('C4B3A204');
      expect(reverseCardUidBytes('041A2B3C4D5E6F')).toBe('6F5E4D3C2B1A04');
    });

    it('refuses values that have no byte order to reverse', () => {
      expect(reverseCardUidBytes('04A2B3C')).toBeNull(); // odd length
      expect(reverseCardUidBytes('ZZZZ')).toBeNull(); // not hex
      expect(reverseCardUidBytes('')).toBeNull();
    });
  });

  describe('cardUidLookupCandidates', () => {
    it('puts the canonical form first so an exact match always wins', () => {
      // Ordering is a correctness property, not an optimization: two distinct
      // cards whose UIDs are byte-reverses of each other must each still
      // resolve to their own truck.
      const candidates = cardUidLookupCandidates('04:a2:b3:c4');
      expect(candidates[0]).toBe('04A2B3C4');
      expect(candidates).toContain('C4B3A204');
      expect(candidates.indexOf('04A2B3C4')).toBeLessThan(candidates.indexOf('C4B3A204'));
    });

    it('retains the raw value so pairings made before normalization still resolve', () => {
      expect(cardUidLookupCandidates('04:a2:b3:c4')).toContain('04:a2:b3:c4');
    });

    it('reaches the same truck from either rendering of one card', () => {
      // The desk reader paired the card as decimal; the phone presents hex,
      // lowercase, colon-separated. Both must land on the stored canonical form.
      const paired = normalizeCardUid('0077771716');
      expect(cardUidLookupCandidates('04:a2:b3:c4')).toContain(paired);
      expect(cardUidLookupCandidates('04A2B3C4')).toContain(paired);
      expect(cardUidLookupCandidates('0077771716')).toContain(paired);
    });

    it('reaches the paired card even when the two devices disagree on byte order', () => {
      const paired = normalizeCardUid('04A2B3C4');
      expect(cardUidLookupCandidates('c4:b3:a2:04')).toContain(paired);
    });

    it('yields nothing for an unusable identifier', () => {
      expect(cardUidLookupCandidates('')).toEqual([]);
      expect(cardUidLookupCandidates('  ')).toEqual([]);
    });
  });
});
