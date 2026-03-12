// Keyword-based sentiment analyzer for pet emotions.
// Inspired by notchi's Claude Haiku API approach, but runs locally.

export interface SentimentResult {
  emotion: 'happy' | 'sad' | 'neutral';
  intensity: number; // 0.0 - 1.0
}

// ── Word lists with intensity tiers ──

// Tier 1 = 0.7 (strong), Tier 2 = 0.5 (medium), Tier 3 = 0.3 (frustration), Tier 4 = 0.2 (mild)

const SAD_WORDS: [RegExp, number][] = [
  // ── Russian heavy profanity (0.7) ──
  [/\bбля(т|д|)/i, 0.7],
  [/\bпизд(?!ат)/i, 0.7],    // пиздец, пизда, but NOT пиздато (happy)
  [/\bнахуй/i, 0.7],
  [/\bхуй(?!ня)/i, 0.6],     // хуй but not хуйня separately
  [/\bхуйн/i, 0.6],
  [/\b[её]б(?!ись)/i, 0.7],   // ебать, ёбаный, but NOT заебись (happy)
  [/\bговн/i, 0.6],
  [/\bдерьм/i, 0.6],
  [/\bу[её]бо?к/i, 0.7],
  [/\bсука/i, 0.5],
  [/\bсуч/i, 0.5],

  // ── Russian medium (0.5) ──
  [/\bмудак/i, 0.5],
  [/\bмудил/i, 0.5],
  [/\bпидор/i, 0.5],
  [/\bдебил/i, 0.5],
  [/\bидиот/i, 0.5],
  [/\bтуп(?:ой|ая|ое|ые|о[йе]?)/i, 0.4],
  [/\bзалуп/i, 0.5],

  // ── Russian frustration (0.3) ──
  [/\bбесит/i, 0.3],
  [/\bзаеба?л/i, 0.4],
  [/\bдостал/i, 0.3],
  [/\bнадоел/i, 0.3],
  [/\bненавиж/i, 0.4],
  [/\bужас/i, 0.3],
  [/\bкошмар/i, 0.3],
  [/\bбред/i, 0.3],
  [/\bчушь/i, 0.3],
  [/\bфигн/i, 0.3],
  [/\bотстой/i, 0.3],
  [/\bдрянь/i, 0.3],
  [/\bубожеств/i, 0.3],
  [/\bзадолба/i, 0.3],
  [/\bкапец/i, 0.3],
  [/\bпипец/i, 0.3],
  [/\bжесть/i, 0.3],
  [/\bппц/i, 0.3],
  [/\bкараул/i, 0.3],
  [/это\s*конец/i, 0.4],
  [/какой\s*ужас/i, 0.5],
  [/\bкатастроф/i, 0.4],
  [/\bпровал/i, 0.3],
  [/\bтрагеди/i, 0.4],
  [/\bпозор/i, 0.4],
  [/\bотврат/i, 0.4],
  [/\bмерзост/i, 0.4],
  [/\bмерзк/i, 0.3],
  [/\bгадост/i, 0.3],
  [/\bтошнит/i, 0.3],
  [/\bубить\s*себя/i, 0.5],
  [/\bвыбеси/i, 0.4],
  [/\bбешус/i, 0.3],
  [/\bзлюсь/i, 0.3],
  [/\bразочаров/i, 0.3],
  [/\bобидн/i, 0.3],
  [/\bнеудач/i, 0.3],
  [/\bпроклят/i, 0.4],
  [/\bненормальн/i, 0.3],
  [/\bневыносим/i, 0.4],
  [/\bнеприемлем/i, 0.3],
  [/\bкрах\b/i, 0.4],
  [/\bфиаско/i, 0.4],
  [/\bстыд/i, 0.3],
  [/\bвсё\s*плох/i, 0.4],
  [/\bне\s*могу\s*больше/i, 0.4],
  [/\bзачем\s*я/i, 0.3],
  [/\bнет\s*сил/i, 0.3],
  [/\bустал/i, 0.2],
  [/\bвыгор/i, 0.3],
  [/\bопять\s*сломал/i, 0.4],
  [/\bвсё\s*слома/i, 0.5],

  // ── Russian mild (0.2) ──
  [/\bблин\b/i, 0.2],
  [/\bч[её]рт/i, 0.2],
  [/\bдьявол/i, 0.2],
  [/\bзараз[аы]/i, 0.2],
  [/\bтьфу/i, 0.2],
  [/\bфу\b/i, 0.2],
  [/\bмда\b/i, 0.2],
  [/\bэх\b/i, 0.15],
  [/\bувы\b/i, 0.2],
  [/\bнеа\b/i, 0.15],

  // ── English heavy profanity (0.7) ──
  [/\bfuck/i, 0.7],
  [/\bshit/i, 0.7],
  [/\bcunt/i, 0.7],
  [/\bmotherfuck/i, 0.7],
  [/\bbullshit/i, 0.6],
  [/\basshole/i, 0.6],

  // ── English medium (0.5) ──
  [/\bdamn/i, 0.5],
  [/\bbitch/i, 0.5],
  [/\bbastard/i, 0.5],
  [/\bcrap/i, 0.4],
  [/\bdick\b/i, 0.4],
  [/\bass\b/i, 0.3],
  [/\bwtf\b/i, 0.5],
  [/\bfml\b/i, 0.5],
  [/\bstfu\b/i, 0.5],
  [/\bffs\b/i, 0.4],
  [/\bgoddam/i, 0.5],

  // ── English frustration (0.3) ──
  [/\bhate\b/i, 0.4],
  [/\bsucks?\b/i, 0.3],
  [/\bterribl/i, 0.3],
  [/\bhorribl/i, 0.3],
  [/\bawful/i, 0.3],
  [/\bworst/i, 0.3],
  [/\bgarbage/i, 0.3],
  [/\btrash/i, 0.3],
  [/\bbroken/i, 0.3],
  [/\buseless/i, 0.3],
  [/\bstupid/i, 0.4],
  [/\bdumb/i, 0.3],
  [/\bridiculous/i, 0.3],
  [/\bnonsense/i, 0.3],
  [/\bannoy/i, 0.3],
  [/\bfrustr/i, 0.3],
  [/\bugh+\b/i, 0.2],
  [/\bar+gh/i, 0.2],
  [/\bpathetic/i, 0.3],
  [/\bdisaster/i, 0.3],
  [/\bnightmare/i, 0.4],
  [/\bcatastroph/i, 0.4],
  [/\bdisgust/i, 0.4],
  [/\bmiserable/i, 0.4],
  [/\bdepressing/i, 0.3],
  [/\bhopeless/i, 0.4],
  [/\bworthless/i, 0.4],
  [/\babysmal/i, 0.4],
  [/\batrocious/i, 0.4],
  [/\binfuriat/i, 0.4],
  [/\boutrage/i, 0.4],
  [/\bdreadful/i, 0.3],
  [/\bappalling/i, 0.4],
  [/\bi\s*give\s*up/i, 0.4],
  [/\bi\s*can'?t\s*anymore/i, 0.4],
  [/\bkill\s*me/i, 0.4],
  [/\bi'?m\s*done/i, 0.3],
  [/\bwasted/i, 0.3],
  [/\bfailed/i, 0.3],
  [/\brunined/i, 0.4],
  [/\bdestroyed/i, 0.4],

  // ── English mild (0.2) ──
  [/\bhell\b/i, 0.2],
  [/\bmeh\b/i, 0.2],
  [/\bnah\b/i, 0.15],
  [/\bsigh\b/i, 0.2],
];

// Happy words — checked FIRST to override dual words (заебись, пиздато, etc.)
const HAPPY_WORDS: [RegExp, number][] = [
  // ── Russian positive mat (0.7) — must be checked before sad ──
  [/заебись/i, 0.7],
  [/ахуенн/i, 0.7],
  [/охуенн/i, 0.7],
  [/пиздат/i, 0.7],

  // ── Russian strong praise (0.7) ──
  [/\bспасиб/i, 0.7],
  [/\bобожа/i, 0.7],
  [/\bвеликолепн/i, 0.7],
  [/\bпотрясающ/i, 0.7],
  [/\bшикарн/i, 0.7],
  [/\bидеальн/i, 0.7],
  [/\bнереальн/i, 0.6],
  [/\bреспект/i, 0.6],
  [/\bгениальн/i, 0.7],
  [/\bбесподобн/i, 0.7],
  [/\bвосхитительн/i, 0.7],
  [/\bблагодар/i, 0.7],

  // ── Russian affectionate address (0.5) — pet feels loved ──
  [/\bпожалуйста/i, 0.5],
  [/\bплиз\b/i, 0.4],
  [/\bбро\b/i, 0.5],
  [/\bбратан/i, 0.5],
  [/\bродн(?:ой|ая|ое)/i, 0.5],
  [/\bдорог(?:ой|ая|ое)/i, 0.5],
  [/\bмилый/i, 0.5],
  [/\bмилая/i, 0.5],
  [/\bдруж/i, 0.4],
  [/\bлюбим/i, 0.6],
  [/\bсолнышк/i, 0.6],
  [/\bзайк/i, 0.5],
  [/\bкотик/i, 0.5],
  [/\bмалыш/i, 0.5],
  [/\bлапочк/i, 0.6],
  [/\bумничк/i, 0.6],
  [/\bмашинк/i, 0.4],
  [/\bлегенд/i, 0.6],
  [/\bгерой/i, 0.5],
  [/\bкрасавч/i, 0.6],

  // ── Russian medium praise (0.5) ──
  [/\bкрут/i, 0.5],
  [/\bкласс\b/i, 0.5],
  [/\bофигенн/i, 0.5],
  [/\bотличн/i, 0.5],
  [/\bпрекрасн/i, 0.5],
  [/\bзамечательн/i, 0.5],
  [/\bсупер/i, 0.5],
  [/\bбраво/i, 0.5],
  [/\bкайф/i, 0.5],
  [/\bогонь\b/i, 0.5],
  [/\bтоп\b/i, 0.4],
  [/\bбомб/i, 0.5],
  [/\bкрасот/i, 0.5],
  [/\bништяк/i, 0.5],
  [/\bзбс\b/i, 0.5],
  [/\bмолод(?:ец|чин)/i, 0.6],
  [/\bчётк/i, 0.4],
  [/\bмощн/i, 0.4],
  [/\bбалдёж/i, 0.5],
  [/\bкруто/i, 0.5],
  [/\bклассн/i, 0.5],
  [/\bвпечатл/i, 0.4],
  [/\bудивительн/i, 0.5],
  [/\bволшебн/i, 0.5],
  [/\bсказочн/i, 0.5],
  [/\bбожественн/i, 0.6],

  // ── Russian success (0.5) ──
  [/\bполучилось/i, 0.5],
  [/\bработает/i, 0.4],
  [/\bзаработал/i, 0.5],
  [/\bпобед/i, 0.5],
  [/\bсделал/i, 0.3],
  [/\bготово/i, 0.4],
  [/\bрешил/i, 0.3],
  [/\bнашёл/i, 0.3],
  [/\bуспе[хш]/i, 0.5],
  [/\bпрорыв/i, 0.5],

  // ── Russian mild (0.3) ──
  [/\bура+\b/i, 0.5],
  [/\bвау\b/i, 0.4],
  [/\bого\b/i, 0.3],
  [/\bнаконец/i, 0.4],
  [/\bе[сш]ь\b/i, 0.3],
  [/\bда\s*ладно/i, 0.3],
  [/\bничего\s*себе/i, 0.4],
  [/\bофигеть/i, 0.4],

  // ── English strong praise (0.7) ──
  [/\bthank/i, 0.7],
  [/\bawesom/i, 0.7],
  [/\bamazin/i, 0.7],
  [/\bperfect/i, 0.7],
  [/\bincredib/i, 0.7],
  [/\bbrilliant/i, 0.7],
  [/\boutstanding/i, 0.7],
  [/\bmagnificen/i, 0.7],
  [/\blove\b/i, 0.6],
  [/\blove it/i, 0.7],

  // ── English affectionate address (0.5) ──
  [/\bplease\b/i, 0.4],
  [/\bbro\b/i, 0.4],
  [/\bbuddy\b/i, 0.4],
  [/\bpal\b/i, 0.3],
  [/\bmate\b/i, 0.3],
  [/\bdude\b/i, 0.3],
  [/\bdarling/i, 0.5],
  [/\bsweetie/i, 0.5],
  [/\bhoney\b/i, 0.5],
  [/\blegend\b/i, 0.5],
  [/\bchamp\b/i, 0.5],
  [/\bgenius/i, 0.6],
  [/\blifesaver/i, 0.6],
  [/\bgoat\b/i, 0.5],
  [/\bking\b/i, 0.4],
  [/\bchef'?s?\s*kiss/i, 0.6],

  // ── English medium praise (0.5) ──
  [/\bgreat\b/i, 0.5],
  [/\bexcellent/i, 0.5],
  [/\bwonderful/i, 0.5],
  [/\bfantastic/i, 0.5],
  [/\bbeautiful/i, 0.5],
  [/\bimpressiv/i, 0.5],
  [/\bsuperb/i, 0.5],
  [/\bnice\b/i, 0.4],
  [/\bcool\b/i, 0.4],
  [/\bnailed/i, 0.5],
  [/\bwell done/i, 0.5],
  [/\bgood job/i, 0.5],
  [/\bbravo/i, 0.5],
  [/\bwow\b/i, 0.4],
  [/\bsolid\b/i, 0.4],
  [/\bflawless/i, 0.6],
  [/\bclean\b/i, 0.3],
  [/\belegant/i, 0.5],
  [/\bslick\b/i, 0.4],
  [/\bsmooth/i, 0.3],
  [/\bspot\s*on/i, 0.5],
  [/\bon\s*point/i, 0.5],
  [/\bchef'?s?\s*kiss/i, 0.6],

  // ── English success (0.5) ──
  [/\bfinally\b/i, 0.4],
  [/\bfixed\b/i, 0.4],
  [/\bsolved/i, 0.4],
  [/\byay\b/i, 0.5],
  [/\bwoohoo/i, 0.5],
  [/\blets?\s*go/i, 0.5],
  [/\bit\s*works/i, 0.5],
  [/\bgot\s*it/i, 0.3],
  [/\bwe'?re\s*good/i, 0.4],
  [/\bship\s*it/i, 0.5],
  [/\blgtm\b/i, 0.5],
  [/\bw\b/i, 0.3],

  // ── Positive bigrams that override negative words ──
  [/hell\s+yeah/i, 0.6],
  [/fuck(?:ing)?\s+(?:awesome|amazing|great|perfect|good|nice|brilliant)/i, 0.6],
  [/damn\s+(?:good|nice|great)/i, 0.5],
  [/no\s+way/i, 0.3],
];

// ── Intensity modifiers ──

function calcModifiers(originalText: string): number {
  let mod = 0;

  // ALL CAPS: >50% of alphabetic chars are uppercase
  const letters = originalText.replace(/[^a-zA-Zа-яА-ЯёЁ]/g, '');
  if (letters.length > 3) {
    const upper = letters.replace(/[^A-ZА-ЯЁ]/g, '').length;
    if (upper / letters.length > 0.5) mod += 0.25;
  }

  // Multiple exclamation marks (3+)
  if (/!{3,}/.test(originalText)) mod += 0.15;

  // Multiple question marks (3+)
  if (/\?{3,}/.test(originalText)) mod += 0.1;

  // Repeated characters (3+ same letter in a row): бляяять, fuuuck
  if (/(.)\1{2,}/i.test(originalText)) mod += 0.1;

  return mod;
}

// ── Main analyzer ──

export function analyzeSentiment(text: string): SentimentResult {
  if (!text || text.length < 2) return { emotion: 'neutral', intensity: 0 };

  const originalText = text;
  const lower = text.toLowerCase();

  // Check happy bigrams/phrases first (overrides negative single words)
  let happyTotal = 0;
  let happyCount = 0;
  const happyMatched = new Set<number>();

  for (let i = 0; i < HAPPY_WORDS.length; i++) {
    const [re, intensity] = HAPPY_WORDS[i];
    if (re.test(lower)) {
      happyTotal += intensity;
      happyCount++;
      happyMatched.add(i);
    }
  }

  // Check sad words, but skip if the match region overlaps with a happy match
  let sadTotal = 0;
  let sadCount = 0;

  for (const [re, intensity] of SAD_WORDS) {
    const match = re.exec(lower);
    if (match) {
      // Check if this word was already claimed by a happy pattern
      const matchedStr = match[0].toLowerCase();
      let overridden = false;
      for (const hi of happyMatched) {
        const happyMatch = HAPPY_WORDS[hi][0].exec(lower);
        if (happyMatch) {
          const hs = happyMatch.index;
          const he = hs + happyMatch[0].length;
          const ss = match.index;
          const se = ss + matchedStr.length;
          // Overlapping ranges → happy overrides sad
          if (ss < he && se > hs) { overridden = true; break; }
        }
      }
      if (!overridden) {
        sadTotal += intensity;
        sadCount++;
      }
    }
  }

  // No keywords matched → neutral
  if (happyCount === 0 && sadCount === 0) {
    return { emotion: 'neutral', intensity: 0 };
  }

  // Determine winner
  let emotion: 'happy' | 'sad';
  let baseIntensity: number;

  if (happyTotal > sadTotal) {
    emotion = 'happy';
    // Average intensity of matched words, boosted slightly by count
    baseIntensity = happyTotal / happyCount + Math.min(0.15, (happyCount - 1) * 0.05);
  } else if (sadTotal > happyTotal) {
    emotion = 'sad';
    baseIntensity = sadTotal / sadCount + Math.min(0.15, (sadCount - 1) * 0.05);
  } else {
    // Tie → sad wins (negativity bias, like in real emotions)
    emotion = 'sad';
    baseIntensity = sadTotal / sadCount;
  }

  // Apply modifiers
  const modifiers = calcModifiers(originalText);
  const intensity = Math.min(1, Math.max(0, baseIntensity + modifiers));

  return { emotion, intensity };
}
