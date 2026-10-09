/**
 * Text Engine Pro: Cleaner & Custom Dictionary Engine (VietReader)
 * Performs two-layer sanitization:
 * 1. Global Junk Cleaner (crawled ads, links, donation prompts, redundant newlines)
 * 2. Custom Dictionary Replacements (user rules per book or global)
 */

// Default junk cleaning patterns
export const GLOBAL_JUNK_PATTERNS = [
  // Website links and URLs
  /https?:\/\/[^\s]+/gi,
  /www\.[^\s]+/gi,
  /\b(?:truyen|tangthuvien|metruyenchu|wikidich|wattpad|bachngocsach|truyencv)\w*\.(?:com|vn|net|org|top|vip|info|me)\b[^\s]*/gi,

  // Common convert notices, donations, crawler footers/headers
  /^\s*(?:Ủng hộ converter|Được đăng tải tại|Bấm theo dõi|Nguồn\s*:|Nhóm dịch\s*:|Donate\b|Momo\s*:?\s*\d+|Zalo\s*:?\s*\d+|Ngân hàng\s*:?\s*[\w\d]+|Xem bản dịch sớm nhất tại|Truyện được convert bởi|Đọc truyện tại|Chúc các bạn đọc truyện vui vẻ).*/gim,

  // In-line crawler watermarks enclosed in brackets or symbols
  /【(?:Ủng hộ|Nguồn|Đăng tải|Theo dõi)[^】]*】/gi,
  /\[(?:Ủng hộ|Nguồn|Đăng tải|Theo dõi)[^\]]*\]/gi,

  // Excess repetitive decoration divider lines (e.g. ------, ======, *****)
  /^[=\-_*~#]{4,}\s*$/gm
];

/**
 * Escapes characters for safe string use inside new RegExp(str).
 * @param {string} str
 * @returns {string}
 */
export function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Layer 1: Removes common crawler garbage, ads, and fixes redundant line breaks.
 * @param {string} text
 * @returns {string}
 */
export function cleanGarbageText(text) {
  if (!text || typeof text !== 'string') return '';

  let result = text;

  // Run all preset junk regexes
  for (const pattern of GLOBAL_JUNK_PATTERNS) {
    result = result.replace(pattern, '');
  }

  // Normalize excessive spaces and line breaks
  // Collapse 3 or more consecutive newlines into 2
  result = result.replace(/\r\n/g, '\n');
  result = result.replace(/[ \t]+$/gm, ''); // Trailing spaces on lines
  result = result.replace(/\n{3,}/g, '\n\n');

  return result.trim();
}

/**
 * Layer 2: Applies user's custom dictionary rules.
 * @param {string} text
 * @param {Array<Object>} rules - Array of { findText, replaceText, isRegex, isCaseSensitive, isEnabled }
 * @returns {string}
 */
export function applyCustomRules(text, rules) {
  if (!text || typeof text !== 'string') return '';
  if (!rules || !Array.isArray(rules) || rules.length === 0) return text;

  let result = text;

  for (const rule of rules) {
    if (!rule || rule.isEnabled === false || !rule.findText) continue;

    try {
      const flags = rule.isCaseSensitive ? 'g' : 'gi';
      let regex;

      if (rule.isRegex) {
        regex = new RegExp(rule.findText, flags);
      } else {
        regex = new RegExp(escapeRegExp(rule.findText), flags);
      }

      const replacement = rule.replaceText !== undefined ? rule.replaceText : '';
      result = result.replace(regex, replacement);
    } catch (err) {
      console.warn(`[TextEnginePro] Bỏ qua quy tắc lỗi [${rule.findText}]:`, err.message);
    }
  }

  return result;
}

/**
 * Complete Two-Layer Pipeline: Global Cleaner + Custom Dictionary Rules.
 * Ensures DOM visual content and TTS speech chunks are 100% synchronized.
 * @param {string} rawText
 * @param {Object} [options]
 * @param {Array<Object>} [options.rules=[]]
 * @param {boolean} [options.enableCleaner=true]
 * @returns {string}
 */
export function cleanChapterText(rawText, options = {}) {
  const { rules = [], enableCleaner = true } = options;
  if (!rawText || typeof rawText !== 'string') return '';

  let processed = rawText;

  // Layer 1: Global Junk Cleaner
  if (enableCleaner) {
    processed = cleanGarbageText(processed);
  }

  // Layer 2: Custom Dictionary Replacements
  if (rules && rules.length > 0) {
    processed = applyCustomRules(processed, rules);
  }

  return processed;
}

/**
 * Validates an array of imported rules.
 * @param {any} data
 * @returns {Array<Object>}
 */
export function validateRules(data) {
  const list = Array.isArray(data) ? data : (data && Array.isArray(data.rules) ? data.rules : null);
  if (!list) {
    throw new Error('Dữ liệu quy tắc không đúng định dạng mảng JSON.');
  }

  return list.map(item => ({
    findText: String(item.findText || '').trim(),
    replaceText: String(item.replaceText || ''),
    isRegex: !!item.isRegex,
    isCaseSensitive: !!item.isCaseSensitive,
    isEnabled: item.isEnabled !== false
  })).filter(r => r.findText.length > 0);
}
