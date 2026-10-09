/**
 * Text Engine Pro: Highlight & Quote Notes Manager (VietReader)
 * Handles text selection floating toolbar, color tagging, inline notes,
 * quote copying, and Obsidian/Notion Markdown export.
 */

export const HIGHLIGHT_COLORS = {
  yellow: { name: 'Vàng chanh', hex: '#fef08a', border: '#eab308' },
  green: { name: 'Xanh mint', hex: '#bbf7d0', border: '#22c55e' },
  blue: { name: 'Xanh pastel', hex: '#bae6fd', border: '#0ea5e9' },
  orange: { name: 'Cam đào', hex: '#fed7aa', border: '#f97316' }
};

/**
 * Formats a single quote for clipboard copy according to standard specification.
 * @param {string} text
 * @param {string} bookTitle
 * @param {string} chapterTitle
 * @returns {string}
 */
export function formatQuoteForClipboard(text, bookTitle, chapterTitle) {
  const clean = (text || '').trim();
  const bTitle = bookTitle || 'Tác phẩm';
  const cTitle = chapterTitle || 'Chương hiện tại';

  return `> "${clean}"\n> — Trích: ${bTitle} | ${cTitle}`;
}

/**
 * Generates structured Markdown for Obsidian / Notion export.
 * @param {string} bookTitle
 * @param {string} author
 * @param {Array<Object>} highlights
 * @param {Array<Object>} chaptersMeta
 * @returns {string}
 */
export function exportHighlightsToMarkdown(bookTitle, author, highlights, chaptersMeta = []) {
  const nowStr = new Date().toLocaleString('vi-VN');
  let md = `# 📖 Trích Dẫn & Ghi Chú: ${bookTitle || 'Tác phẩm'}\n\n`;
  md += `- **Tác giả:** ${author || 'Khuyết danh'}\n`;
  md += `- **Tổng số trích dẫn:** ${highlights.length}\n`;
  md += `- **Thời gian xuất:** ${nowStr}\n`;
  md += `- **Nguồn:** VietReader (Personal Reader Web App)\n\n`;
  md += `---\n\n`;

  if (highlights.length === 0) {
    md += `*(Chưa có trích dẫn hoặc ghi chú nào)*\n`;
    return md;
  }

  // Group highlights by chapterIndex
  const byChapter = {};
  for (const h of highlights) {
    const chIdx = h.chapterIndex !== undefined ? h.chapterIndex : 0;
    if (!byChapter[chIdx]) byChapter[chIdx] = [];
    byChapter[chIdx].push(h);
  }

  const sortedChapterKeys = Object.keys(byChapter).map(Number).sort((a, b) => a - b);

  for (const chIdx of sortedChapterKeys) {
    const meta = chaptersMeta.find(c => c.chapterIndex === chIdx);
    const chapterName = meta ? meta.title : `Chương ${chIdx + 1}`;

    md += `## 📑 ${chapterName}\n\n`;

    for (const h of byChapter[chIdx]) {
      const colorName = HIGHLIGHT_COLORS[h.color]?.name || h.color;
      const dateStr = h.createdAt ? new Date(h.createdAt).toLocaleDateString('vi-VN') : '';

      md += `> ${h.selectedText}\n\n`;
      if (h.noteText && h.noteText.trim()) {
        md += `💭 **Ghi chú:** ${h.noteText.trim()}\n\n`;
      }
      md += `*🏷️ Đánh dấu: ${colorName}${dateStr ? ` · ${dateStr}` : ''}*\n\n---\n\n`;
    }
  }

  return md;
}

/**
 * Escapes regex string characters safely.
 */
function escapeReg(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Injects `<mark class="reader-highlight hl-[color]" data-highlight-id="[id]">` into HTML
 * based on saved highlights list, preserving surrounding DOM and TTS spans.
 * @param {HTMLElement} containerEl
 * @param {Array<Object>} highlights
 */
export function applyHighlightsToContainer(containerEl, highlights) {
  if (!containerEl || !highlights || highlights.length === 0) return;

  // For each highlight, search within reader paragraphs and wrap matching text
  // Sort highlights by length descending to match longer phrases first
  const sorted = [...highlights].sort((a, b) => (b.selectedText?.length || 0) - (a.selectedText?.length || 0));

  for (const h of sorted) {
    if (!h.selectedText || h.selectedText.trim().length < 2) continue;

    const searchText = h.selectedText.trim();
    const regex = new RegExp(`(${escapeReg(searchText)})`, 'gi');

    // Find all text nodes inside paragraphs that are not already inside a mark tag
    const walker = document.createTreeWalker(
      containerEl,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          if (!node.textContent.trim()) return NodeFilter.FILTER_REJECT;
          if (node.parentElement && node.parentElement.closest('mark.reader-highlight')) {
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    const nodesToReplace = [];
    let currentNode;
    while ((currentNode = walker.nextNode())) {
      if (regex.test(currentNode.textContent)) {
        nodesToReplace.push(currentNode);
        break; // Match first occurrence in chapter
      }
    }

    for (const node of nodesToReplace) {
      const parent = node.parentNode;
      if (!parent) continue;

      const span = document.createElement('span');
      const noteTitle = h.noteText ? `Ghi chú: ${h.noteText}` : 'Nhấp để xem hoặc chỉnh sửa';
      span.innerHTML = node.textContent.replace(
        regex,
        `<mark class="reader-highlight hl-${h.color || 'yellow'}" data-highlight-id="${h.id}" title="${escapeHTML(noteTitle)}">$1</mark>`
      );

      while (span.firstChild) {
        parent.insertBefore(span.firstChild, node);
      }
      parent.removeChild(node);
    }
  }
}

/**
 * Escapes HTML attributes/content safely.
 */
function escapeHTML(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
