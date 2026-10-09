/**
 * Text & Document Parser for Personal Reader (VietReader)
 * Handles .txt, .pdf (via pdfjsLib), and .epub (via JSZip + DOMParser)
 * Features intelligent Vietnamese chapter splitting with word-boundary fallback.
 */

// Regex patterns to detect chapter headings in Vietnamese and international literature
const CHAPTER_REGEX_PATTERNS = [
  /^(?:Chương|Hồi|Quyển|Chapter|Tiết|Phần|Mục)\s+(?:thứ\s+)?([0-9IVXLCDMivxlcdm]+|[a-zA-ZÀ-ỹ0-9]+)(?:[:\s\-\.\–\—].*)?$/i,
  /^(?:Hồi\s+thứ\s+[^\n:]+)(?:[:\s\-\.\–\—].*)?$/i,
  /^(?:Thứ\s+[^\n:]+\s+(?:chương|hồi|phần))(?:[:\s\-\.\–\—].*)?$/i
];

/**
 * Checks if a trimmed line is a chapter heading.
 * @param {string} line
 * @returns {boolean}
 */
export function isChapterHeading(line) {
  if (!line || line.length > 120) return false;
  const trimmed = line.trim();
  return CHAPTER_REGEX_PATTERNS.some(regex => regex.test(trimmed));
}

/**
 * Splits plain text into chapters intelligently.
 * @param {string} rawText
 * @param {string} fallbackTitle
 * @returns {Array<{ chapterIndex: number, title: string, content: string, wordCount: number }>}
 */
export function splitTextIntoChapters(rawText, fallbackTitle = 'Tác phẩm') {
  if (!rawText || !rawText.trim()) {
    return [{
      chapterIndex: 0,
      title: 'Chương 1',
      content: 'Nội dung trống.',
      wordCount: 0
    }];
  }

  // Normalize line breaks
  const normalized = rawText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');

  const detectedChapters = [];
  let currentTitle = '';
  let currentLines = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (isChapterHeading(trimmed)) {
      if (currentLines.length > 0 || currentTitle) {
        const contentStr = currentLines.join('\n').trim();
        detectedChapters.push({
          title: currentTitle || 'Mở đầu / Giới thiệu',
          content: contentStr,
          wordCount: countWords(contentStr)
        });
        currentLines = [];
      }
      currentTitle = trimmed;
    } else {
      currentLines.push(line);
    }
  }

  // Push final remaining segment
  if (currentLines.length > 0 || currentTitle) {
    const contentStr = currentLines.join('\n').trim();
    detectedChapters.push({
      title: currentTitle || (detectedChapters.length === 0 ? 'Toàn văn' : `Chương ${detectedChapters.length + 1}`),
      content: contentStr,
      wordCount: countWords(contentStr)
    });
  }

  // FALLBACK CHECK:
  // If no chapter headings were detected or only 1 huge chapter exists (> 3000 words),
  // split into chunks of ~2000 - 3000 words based on paragraph boundaries.
  const totalWords = detectedChapters.reduce((acc, ch) => acc + ch.wordCount, 0);
  if (detectedChapters.length <= 1 && totalWords > 2500) {
    return fallbackSplitByWordCount(normalized, fallbackTitle);
  }

  return detectedChapters.map((ch, idx) => ({
    chapterIndex: idx,
    title: ch.title,
    content: ch.content,
    wordCount: ch.wordCount
  }));
}

/**
 * Fallback splitter when text has no chapter markers.
 * Splits into chunks of 2000-2800 words along paragraph breaks.
 */
function fallbackSplitByWordCount(text, titlePrefix) {
  const paragraphs = text.split(/\n\s*\n+/);
  const chapters = [];
  let currentChunk = [];
  let currentWords = 0;
  const TARGET_WORDS_PER_CHUNK = 2200;

  for (let i = 0; i < paragraphs.length; i++) {
    const para = paragraphs[i].trim();
    if (!para) continue;

    const pWords = countWords(para);
    currentChunk.push(para);
    currentWords += pWords;

    if (currentWords >= TARGET_WORDS_PER_CHUNK && i < paragraphs.length - 1) {
      const content = currentChunk.join('\n\n');
      chapters.push({
        chapterIndex: chapters.length,
        title: `Phần ${chapters.length + 1}`,
        content,
        wordCount: currentWords
      });
      currentChunk = [];
      currentWords = 0;
    }
  }

  if (currentChunk.length > 0) {
    const content = currentChunk.join('\n\n');
    chapters.push({
      chapterIndex: chapters.length,
      title: chapters.length === 0 ? 'Toàn văn' : `Phần ${chapters.length + 1}`,
      content,
      wordCount: countWords(content)
    });
  }

  return chapters;
}

/**
 * Counts words accurately with Unicode Vietnamese support.
 */
export function countWords(str) {
  if (!str) return 0;
  const matches = str.trim().match(/\S+/g);
  return matches ? matches.length : 0;
}

/**
 * Reads a .txt file.
 * @param {File} file
 * @returns {Promise<{ title: string, author: string, rawText: string }>}
 */
export async function parseTxtFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const rawText = e.target.result;
      const cleanTitle = file.name.replace(/\.[^/.]+$/, '');
      resolve({
        title: cleanTitle,
        author: 'Khuyết danh',
        rawText
      });
    };
    reader.onerror = () => reject(new Error('Không thể đọc file TXT.'));
    reader.readAsText(file, 'utf-8');
  });
}

/**
 * Reads a .pdf file using PDF.js
 * @param {File} file
 * @param {Function} onProgress - Optional callback for percentage
 * @returns {Promise<{ title: string, author: string, rawText: string }>}
 */
export async function parsePdfFile(file, onProgress) {
  if (typeof window.pdfjsLib === 'undefined') {
    throw new Error('Thư viện PDF.js chưa sẵn sàng.');
  }

  const arrayBuffer = await file.arrayBuffer();
  const loadingTask = window.pdfjsLib.getDocument({ data: arrayBuffer });
  const pdfDoc = await loadingTask.promise;

  let metadataTitle = '';
  let metadataAuthor = '';
  try {
    const meta = await pdfDoc.getMetadata();
    if (meta?.info) {
      metadataTitle = meta.info.Title || '';
      metadataAuthor = meta.info.Author || '';
    }
  } catch (e) {
    console.warn('PDF metadata warning:', e);
  }

  const numPages = pdfDoc.numPages;
  const textPages = [];

  for (let i = 1; i <= numPages; i++) {
    const page = await pdfDoc.getPage(i);
    const content = await page.getTextContent();
    const pageText = content.items
      .map(item => item.str)
      .join(' ');
    textPages.push(pageText);

    if (typeof onProgress === 'function') {
      onProgress(Math.round((i / numPages) * 100));
    }
  }

  const cleanTitle = metadataTitle.trim() || file.name.replace(/\.[^/.]+$/, '');
  const cleanAuthor = metadataAuthor.trim() || 'Khuyết danh';

  return {
    title: cleanTitle,
    author: cleanAuthor,
    rawText: textPages.join('\n\n')
  };
}

/**
 * Reads a .epub file using JSZip + DOMParser
 * Extracts OPF, spine items, and chapter text while preserving logical chapters.
 * @param {File} file
 * @returns {Promise<{ title: string, author: string, chapters: Array<any>, rawText: string }>}
 */
export async function parseEpubFile(file) {
  if (typeof window.JSZip === 'undefined') {
    throw new Error('Thư viện JSZip chưa sẵn sàng.');
  }

  const zip = new window.JSZip();
  const loadedZip = await zip.loadAsync(file);

  // 1. Locate container.xml
  const containerFile = loadedZip.file('META-INF/container.xml');
  if (!containerFile) {
    throw new Error('File EPUB không đúng cấu trúc chuẩn (thiếu META-INF/container.xml).');
  }

  const containerXml = await containerFile.async('text');
  const domParser = new DOMParser();
  const containerDoc = domParser.parseFromString(containerXml, 'application/xml');
  const rootfileEl = containerDoc.querySelector('rootfile');
  const opfPath = rootfileEl ? rootfileEl.getAttribute('full-path') : 'content.opf';

  // 2. Read OPF file
  const opfFile = loadedZip.file(opfPath);
  if (!opfFile) {
    throw new Error(`Không tìm thấy file định nghĩa sách: ${opfPath}`);
  }

  const opfXml = await opfFile.async('text');
  const opfDoc = domParser.parseFromString(opfXml, 'application/xml');

  // Base directory for resolving relative hrefs
  const opfDir = opfPath.includes('/') ? opfPath.substring(0, opfPath.lastIndexOf('/') + 1) : '';

  // Extract Metadata
  const titleEl = opfDoc.querySelector('metadata title, dc\\:title');
  const authorEl = opfDoc.querySelector('metadata creator, dc\\:creator');
  const bookTitle = titleEl?.textContent?.trim() || file.name.replace(/\.[^/.]+$/, '');
  const bookAuthor = authorEl?.textContent?.trim() || 'Khuyết danh';

  // Manifest items map (id -> href)
  const manifestItems = {};
  opfDoc.querySelectorAll('manifest item').forEach(item => {
    const id = item.getAttribute('id');
    const href = item.getAttribute('href');
    if (id && href) {
      manifestItems[id] = href;
    }
  });

  // Spine itemref order
  const spineItemRefs = [];
  opfDoc.querySelectorAll('spine itemref').forEach(ref => {
    const idref = ref.getAttribute('idref');
    if (idref && manifestItems[idref]) {
      spineItemRefs.push(manifestItems[idref]);
    }
  });

  // Read spine documents in order
  const extractedChapters = [];
  let chapterIndex = 0;

  for (const relativeHref of spineItemRefs) {
    // Resolve full path inside zip
    const fullPath = resolveRelativePath(opfDir, decodeURIComponent(relativeHref));
    const contentFile = loadedZip.file(fullPath);
    if (!contentFile) continue;

    const htmlText = await contentFile.async('text');
    const doc = domParser.parseFromString(htmlText, 'text/html');

    // Extract title from h1-h3 or doc title
    const heading = doc.querySelector('h1, h2, h3, .chapter-title, .title')?.textContent?.trim();
    // Clean text by stripping scripts, styles
    doc.querySelectorAll('script, style, noscript').forEach(el => el.remove());

    const paragraphs = [];
    doc.body.querySelectorAll('p, div, h1, h2, h3, h4, h5, h6, blockquote, li').forEach(node => {
      const text = node.textContent?.trim();
      if (text && text.length > 0) {
        // Prevent duplicate nested node text if parent is also selected
        if (!node.querySelector('p, div, blockquote')) {
          paragraphs.push(text);
        }
      }
    });

    const bodyText = paragraphs.length > 0 ? paragraphs.join('\n\n') : doc.body.textContent.trim();
    const words = countWords(bodyText);

    // Skip tiny filler pages (like empty copyright/spacer pages with < 10 words)
    if (words > 15) {
      extractedChapters.push({
        chapterIndex: chapterIndex++,
        title: heading || `Chương ${chapterIndex}`,
        content: bodyText,
        wordCount: words
      });
    }
  }

  // If spine parsing yielded good chapters, return them directly
  if (extractedChapters.length > 0) {
    return {
      title: bookTitle,
      author: bookAuthor,
      chapters: extractedChapters,
      rawText: extractedChapters.map(c => `${c.title}\n\n${c.content}`).join('\n\n---\n\n')
    };
  }

  // Fallback to text parsing
  return {
    title: bookTitle,
    author: bookAuthor,
    chapters: [],
    rawText: 'Không tìm thấy nội dung văn bản trong EPUB này.'
  };
}

/**
 * Resolves relative file paths within zip archives.
 */
function resolveRelativePath(baseDir, relativePath) {
  if (!baseDir) return relativePath;
  const stack = baseDir.split('/').filter(Boolean);
  const parts = relativePath.split('/');

  for (const p of parts) {
    if (p === '.') continue;
    if (p === '..') {
      stack.pop();
    } else {
      stack.push(p);
    }
  }
  return stack.join('/');
}
