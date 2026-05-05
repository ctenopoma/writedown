/**
 * markdown-it plugin for academic features:
 *   - Auto-numbering: Figure, Table, Listing, Equation
 *   - TOC generation from [TOC] / [[TOC]] markers
 *
 * Syntax conventions:
 *   Figure:   ![alt](src "fig: Caption text")   → auto-numbered as "図1: Caption text"
 *   Table:    <!-- table: Caption text -->        directly before a table block
 *   Listing:  ````lang listing: Caption text`    fenced code with "listing:" in info string
 *   Equation: $$...$$ (displayed math)            numbered with (1), (2), ...
 *   TOC:      [TOC] or [[TOC]] on its own line
 */

import type MarkdownIt from "markdown-it";
import katex from "katex";

// @types/markdown-it v14 exposes these as namespace members, not subpath modules
type Token = MarkdownIt.Token;
type StateCore = MarkdownIt.StateCore;

// ──────────────────────────────────────────────
// Plugin options
// ──────────────────────────────────────────────
export interface AcademicPluginOptions {
  /** 章番号を自動付与するか（デフォルト: true） */
  sectionNumbering: boolean;
  /**
   * 採番を始めるレベル（1=h1から、2=h2から）
   * 2のとき h1 は無番号タイトル扱い
   */
  sectionBaseLevel: 1 | 2 | 3 | 4 | 5 | 6;
}

const DEFAULT_OPTIONS: AcademicPluginOptions = {
  sectionNumbering: true,
  sectionBaseLevel: 2,
};

// ──────────────────────────────────────────────
// Shared counter state (reset per render pass)
// ──────────────────────────────────────────────
interface Counters {
  figure: number;
  table: number;
  listing: number;
  equation: number;
}

function freshCounters(): Counters {
  return { figure: 0, table: 0, listing: 0, equation: 0 };
}

// ──────────────────────────────────────────────
// Plugin entry point
// ──────────────────────────────────────────────
export function academicMarkdownPlugin(
  md: MarkdownIt,
  userOptions?: Partial<AcademicPluginOptions> | (() => Partial<AcademicPluginOptions>)
): void {
  // ── Fence renderer override ─────────────────────────────
  const originalFence = md.renderer.rules.fence;
  md.renderer.rules.fence = (tokens, idx, options, env, self) => {
    const tok = tokens[idx];
    const meta = tok.meta as { listingCaption?: string; listingId?: string } | undefined;
    const base = originalFence
      ? originalFence(tokens, idx, options, env, self)
      : self.renderToken(tokens, idx, options);
    if (meta?.listingCaption) {
      return `<figure class="listing" id="${meta.listingId ?? ""}">\n` +
             `<figcaption class="listing-caption">${meta.listingCaption}</figcaption>\n` +
             base +
             `</figure>\n`;
    }
    return base;
  };

  // --- をページ区切り div に変換
  // スクリーン: acad-page-sep と同スタイルで表示
  // PDF: page-break-after:always でページを強制改ページ
  md.renderer.rules.hr = () => `<div class="manual-pagebreak"></div>\n`;

  // Core rule — resolve opts fresh each render so config changes take effect
  md.core.ruler.push("academic_numbering", (state: StateCore) => {
    const resolved = typeof userOptions === "function" ? userOptions() : (userOptions ?? {});
    const opts: AcademicPluginOptions = { ...DEFAULT_OPTIONS, ...resolved };
    try {
      runCoreRule(state, opts);
    } catch (err) {
      console.error("[Academic Markdown] Plugin error in core rule:", err);
    }
  });
}

function runCoreRule(state: StateCore, opts: AcademicPluginOptions): void {
    const counters = freshCounters();
    const tokens: Token[] = state.tokens;

    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];

      // ── TOC marker ──────────────────────────
      if (tok.type === "inline" && tok.content) {
        const trimmed = tok.content.trim();
        if (trimmed === "[TOC]" || trimmed === "[[TOC]]") {
          tok.type = "html_block";
          tok.content = buildTocPlaceholder();
          continue;
        }
      }

      // ── Table caption via HTML comment ──────
      // <!-- table: Caption --> immediately before a table
      if (tok.type === "html_block") {
        const m = tok.content.match(/<!--\s*table:\s*(.+?)\s*-->/s);
        if (m && i + 1 < tokens.length) {
          counters.table++;
          const caption = `表${counters.table}: ${m[1].trim()}`;
          // Inject a <p class="caption"> before the next table
          const capToken = new state.Token("html_block", "", 0);
          capToken.content = `<p class="caption table-caption" id="table-${counters.table}">${escapeHtml(caption)}</p>\n`;
          tokens.splice(i + 1, 0, capToken);
          i++; // skip the inserted token
        }
      }

      // ── Inline image with "fig: Caption" title ──
      if (tok.type === "inline" && tok.children) {
        for (let j = 0; j < tok.children.length; j++) {
          const child = tok.children[j];
          if (child.type === "image") {
            const title: string = (child.attrGet("title") as string) ?? "";
            const figMatch = title.match(/^fig:\s*(.+)$/);
            if (figMatch) {
              counters.figure++;
              const caption = `図${counters.figure}: ${figMatch[1].trim()}`;
              child.attrSet("title", "");
              child.attrSet("data-caption", caption);
              child.attrSet("id", `figure-${counters.figure}`);

              // Insert caption element after closing image tag
              const capHtml = new state.Token("html_inline", "", 0);
              capHtml.content = `<figcaption>${escapeHtml(caption)}</figcaption>`;

              // Wrap image in <figure>
              const openFig = new state.Token("html_inline", "", 0);
              openFig.content = `<figure id="figure-${counters.figure}">`;
              const closeFig = new state.Token("html_inline", "", 0);
              closeFig.content = `</figure>`;

              tok.children.splice(j, 0, openFig);
              tok.children.splice(j + 2, 0, capHtml, closeFig);
              j += 3;
            }
          }
        }
      }

      // ── Fenced code with "listing:" in info string ──
      // Store caption in tok.meta and strip "listing:..." from info so that
      // the original fence renderer (with syntax highlighting) still runs.
      // The fence renderer override in academicMarkdownPlugin wraps it in <figure>.
      if (tok.type === "fence") {
        const info: string = tok.info ?? "";
        const listingMatch = info.match(/listing:\s*(.+)$/);
        if (listingMatch) {
          counters.listing++;
          const caption = escapeHtml(`リスト${counters.listing}: ${listingMatch[1].trim()}`);
          tok.meta = { listingCaption: caption, listingId: `listing-${counters.listing}` };
          tok.info = info.replace(/\s*listing:\s*.+$/, "").trim();
        }
      }
    }

    // Second pass: heading section numbering (before TOC so numbers appear in TOC)
    if (opts.sectionNumbering) {
      numberHeadings(tokens, state, opts.sectionBaseLevel);
    }

    // Third pass: build and inject actual TOC HTML
    const headings = collectHeadings(tokens);
    injectToc(tokens, headings, state);

    // Third pass: number displayed equations $$...$$
    numberEquations(tokens, counters, state);
}

// ──────────────────────────────────────────────
// Heading collection for TOC
// ──────────────────────────────────────────────
interface HeadingInfo {
  level: number;
  text: string;
  id: string;
}

function collectHeadings(tokens: Token[]): HeadingInfo[] {
  const headings: HeadingInfo[] = [];
  const idCount: Record<string, number> = {};

  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type === "heading_open") {
      const level = parseInt(tokens[i].tag.slice(1), 10);
      const inlineToken = tokens[i + 1];
      const text = inlineToken ? extractText(inlineToken) : "";
      const rawId = slugify(text);
      idCount[rawId] = (idCount[rawId] ?? -1) + 1;
      const id = idCount[rawId] === 0 ? rawId : `${rawId}-${idCount[rawId]}`;

      // Attach id attribute to the heading_open token
      tokens[i].attrSet("id", id);
      headings.push({ level, text, id });
    }
  }
  return headings;
}

function extractText(token: Token): string {
  if (token.type === "inline" && token.children) {
    return token.children
      .filter((c: Token) => c.type === "text" || c.type === "code_inline")
      .map((c: Token) => c.content)
      .join("");
  }
  return token.content ?? "";
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w　-鿿゠-ヿ぀-ゟ]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// ──────────────────────────────────────────────
// TOC placeholder & injection
// ──────────────────────────────────────────────
const TOC_PLACEHOLDER = "<!--__ACADEMIC_TOC_PLACEHOLDER__-->";

function buildTocPlaceholder(): string {
  return TOC_PLACEHOLDER + "\n";
}

function injectToc(tokens: Token[], headings: HeadingInfo[], state: StateCore): void {
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (
      (tok.type === "html_block" || tok.type === "inline") &&
      tok.content.includes(TOC_PLACEHOLDER)
    ) {
      const tocHtml = buildTocHtml(headings);
      const newTok = new state.Token("html_block", "", 0);
      newTok.content = tocHtml;
      tokens.splice(i, 1, newTok);
    }
  }
}

function buildTocHtml(headings: HeadingInfo[]): string {
  if (headings.length === 0) {
    return `<nav class="toc"><p>（見出しがありません）</p></nav>`;
  }

  const minLevel = Math.min(...headings.map((h) => h.level));
  let html = `<nav class="toc" aria-label="目次">\n<h2 class="toc-title">目次</h2>\n<ul>\n`;
  let currentLevel = minLevel;

  for (const h of headings) {
    const diff = h.level - currentLevel;
    if (diff > 0) {
      html += "<ul>\n".repeat(diff);
    } else if (diff < 0) {
      html += "</li>\n</ul>\n".repeat(-diff);
      html += "</li>\n";
    } else if (currentLevel !== minLevel) {
      html += "</li>\n";
    }
    currentLevel = h.level;
    html += `<li><a href="#${h.id}">${escapeHtml(h.text)}</a>`;
  }

  // Close remaining open tags
  html += "</li>\n";
  const closingDepth = currentLevel - minLevel;
  if (closingDepth > 0) {
    html += "</ul>\n</li>\n".repeat(closingDepth);
  }
  html += "</ul>\n</nav>\n";
  return html;
}

// ──────────────────────────────────────────────
// Equation numbering
// ──────────────────────────────────────────────

/**
 * KaTeX を Node.js 側でサーバーレンダリングし、採番 div で包む。
 * math_block トークンは @traptitech/markdown-it-katex の block tokenizer が生成する。
 * 本関数をその core rule より先に実行することで、katex plugin の二重処理を防ぐ。
 */
function numberEquations(tokens: Token[], counters: Counters, state: StateCore): void {
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.type !== "math_block") { continue; }

    counters.equation++;
    const n = counters.equation;

    let rendered: string;
    try {
      rendered = katex.renderToString(tok.content.trim(), {
        displayMode: true,
        throwOnError: false,
        output: "html",
      });
    } catch {
      rendered = `<code class="katex-error">${escapeHtml(tok.content.trim())}</code>`;
    }

    const newTok = new state.Token("html_block", "", 0);
    newTok.content =
      `<div class="equation-block" id="eq-${n}">` +
      `<div class="equation-content">${rendered}</div>` +
      `<span class="equation-number">(${n})</span>` +
      `</div>\n`;
    tokens.splice(i, 1, newTok);
  }
}

// ──────────────────────────────────────────────
// Heading section numbering
// ──────────────────────────────────────────────

/**
 * Walk through heading_open tokens and prepend "1.", "1.1.", … prefixes.
 *
 * baseLevel = 1: h1→"1", h2→"1.1", h3→"1.1.1" …
 * baseLevel = 2: h1 is untouched (document title),
 *                h2→"1", h3→"1.1", h4→"1.1.1" …
 *
 * The prefix is inserted as the first child text node of the following
 * inline token so the original renderer (and VS Code syntax highlighting)
 * is preserved. The inline.content string is also updated so extractText()
 * picks up the number when building the TOC.
 */
function numberHeadings(
  tokens: Token[],
  state: StateCore,
  baseLevel: number
): void {
  // counters[0] corresponds to baseLevel, counters[1] to baseLevel+1, etc.
  const counters = new Array<number>(7 - baseLevel).fill(0);

  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type !== "heading_open") { continue; }

    const absLevel = parseInt(tokens[i].tag.slice(1), 10); // 1..6
    if (absLevel < baseLevel) { continue; }                // skip title level

    const rel = absLevel - baseLevel; // 0-based index into counters

    counters[rel]++;
    for (let d = rel + 1; d < counters.length; d++) { counters[d] = 0; }

    // "1.2.3" — no trailing dot, single space separator before title
    const prefix = counters.slice(0, rel + 1).join(".") + " ";

    const inlineTok = tokens[i + 1];
    if (inlineTok?.type === "inline") {
      // Prepend to children (already parsed at this stage)
      if (inlineTok.children) {
        const prefixTok = new state.Token("text", "", 0);
        prefixTok.content = prefix;
        inlineTok.children.unshift(prefixTok);
      }
      // Keep .content in sync for extractText() used by TOC
      inlineTok.content = prefix + inlineTok.content;
    }
  }
}

// ──────────────────────────────────────────────
// Utility
// ──────────────────────────────────────────────
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
