// Autonomous computer-use mode (docs/v0.1-computer-use-addendum.md) — the
// hard payment-card block for desktop.type. OpenAI's computer-use actions
// carry only coordinates or literal typed text, never a semantic "this is a
// payment field" signal — a click into a card-number input is
// indistinguishable from a click anywhere else. The typed text itself is the
// only detectable moment, so this is deliberately narrow: a Luhn-valid
// 13-19 digit run, not a general sensitive-data detector. False negatives are
// expected and accepted (see the addendum's known-gaps framing) — this is
// defense in depth, not a guarantee.

/** True if `digits` (already stripped of separators) passes the standard
 * Luhn checksum used by all major card networks. */
function passesLuhn(digits: string): boolean {
  let sum = 0;
  let alternate = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48; // '0'
    if (alternate) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alternate = !alternate;
  }
  return sum % 10 === 0;
}

const MIN_CARD_LEN = 13;
const MAX_CARD_LEN = 19; // ISO/IEC 7812

/** Scans free text for any digit run (spaces/dashes stripped, matching how
 * card numbers are typically typed — "4111 1111 1111 1111" or
 * "4111-1111-1111-1111") that passes the Luhn checksum. Checks every
 * card-length window (13-19 digits) within each maximal digit run, not just
 * a single greedy match — a longer digit run (e.g. an order number
 * containing an embedded card number) can still have the real card number
 * inside it caught. */
export function looksLikePaymentCardNumber(text: string): boolean {
  const stripped = text.replace(/[ -]/g, "");
  const runs = stripped.match(/\d+/g);
  if (!runs) return false;

  for (const run of runs) {
    for (let len = MIN_CARD_LEN; len <= Math.min(MAX_CARD_LEN, run.length); len++) {
      for (let start = 0; start + len <= run.length; start++) {
        if (passesLuhn(run.slice(start, start + len))) return true;
      }
    }
  }
  return false;
}
