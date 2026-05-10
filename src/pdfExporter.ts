/**
 * PdfExporter — converts rendered Markdown HTML to PDF via Puppeteer.
 *
 * Page-number control strategy
 * ─────────────────────────────
 * Puppeteer's headerTemplate/footerTemplate are injected into EVERY page
 * as a separate shadow DOM, so normal @page CSS doesn't reach them.
 *
 * To implement "skip page number on cover (page 1), start counting from 1
 * on page 2":
 *
 *   Option A (CSS-only):  Use CSS counter-reset in a @page :first rule
 *   combined with a custom CSS counter printed via ::after on every page.
 *   This works only when the page number is part of the document body, not
 *   the Puppeteer footer template.
 *
 *   Option B (Puppeteer footerTemplate + JS post-processing):
 *   Puppeteer exposes <span class="pageNumber"> and <span class="totalPages">
 *   in the footer/header template.  We can use a CSS rule inside the template
 *   that hides the footer on page 1 and adjusts the counter.
 *
 * We use Option B with a CSS trick inside footerTemplate:
 *   - The template is duplicated: one hidden version for page 1,
 *     one visible version for all other pages.
 *   - The actual page number displayed is pageNumber - 1, so page 2
 *     shows "1", page 3 shows "2", etc.
 *   - This requires the footer script to compute (pageNumber - 1) at render
 *     time. Puppeteer evaluates <script> inside header/footer templates
 *     in the page context BEFORE printing each page, so we can use JS.
 *
 * See renderFooterTemplate() for the implementation.
 */

import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import * as vscode from "vscode";

// We import puppeteer-core lazily to avoid load-time failures when it is not
// installed (e.g., during development without node_modules).
type Browser = import("puppeteer-core").Browser;
type Page = import("puppeteer-core").Page;

// ──────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────

export interface PdfExportOptions {
  /** Absolute path to the source Markdown file */
  markdownPath: string;
  /** Fully-rendered HTML string (body content only, or full document) */
  htmlContent: string;
  /** Output PDF path (defaults to same dir as markdownPath, .pdf extension) */
  outputPath?: string;
  /** CSS string to embed in the exported document */
  css?: string;
}

export class PdfExporter {
  private config: vscode.WorkspaceConfiguration;

  constructor(private readonly extensionPath: string) {
    this.config = vscode.workspace.getConfiguration("academic-md");
  }

  /** 拡張インストールディレクトリ内のパスを file:// URL に変換 */
  private toFileUrl(relativePath: string): string {
    const abs = path.join(this.extensionPath, relativePath).replace(/\\/g, "/");
    return `file:///${abs}`;
  }

  async export(options: PdfExportOptions): Promise<string> {
    const outputPath =
      options.outputPath ??
      options.markdownPath.replace(/\.(md|markdown)$/i, ".pdf");

    // Merge: base CSS → caller-supplied CSS → user's custom CSS file
    const customCssPath = this.config.get<string>("pdf.customCssPath", "");
    let customCss = options.css ?? "";
    if (customCssPath && fs.existsSync(customCssPath)) {
      customCss += "\n" + fs.readFileSync(customCssPath, "utf-8");
    }

    // プレビュー用の mermaid-source ブロックを PDF 用 mermaid ブロックに変換
    const bodyHtml = options.htmlContent.replace(
      /<div class="mermaid-source">[\s\S]*?<pre><code class="language-mermaid">([\s\S]*?)<\/code><\/pre>\s*<\/div>/g,
      (_match, inner) => `<div class="mermaid">${inner.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")}</div>`
    );

    const html = this.buildFullHtml(bodyHtml, customCss);

    // Write to a temp file so that file:// asset URLs resolve correctly
    const tempPath = path.join(os.tmpdir(), `academic-md-${Date.now()}.html`);
    fs.writeFileSync(tempPath, html, "utf-8");

    let browser: Browser | undefined;
    try {
      browser = await this.launchBrowser();
      const page = await browser.newPage();

      // screen モードで mermaid SVG が正しく描画されるようにする
      // (print モードだと foreignObject や SVG text が正しくレンダリングされない)
      await page.emulateMediaType("screen");

      const tempUrl = "file:///" + tempPath.replace(/\\/g, "/");
      await page.goto(tempUrl, { waitUntil: "networkidle0" });

      await this.waitForRender(page);

      const pdfBuffer = await page.pdf(this.buildPdfOptions(outputPath));

      // ページ番号を再計算（pageNumberFirstValue / skip-first を反映）
      const renumbered = await this.renumberPages(pdfBuffer);

      fs.writeFileSync(outputPath, renumbered);
      return outputPath;
    } finally {
      await browser?.close();
      fs.unlink(tempPath, () => {});
    }
  }

  // ──────────────────────────────────────────────
  // PDF post-processing: renumber pages
  // ──────────────────────────────────────────────
  /**
   * Puppeteer's footerTemplate uses `<span class="pageNumber">` whose text is
   * the actual physical page index. To support `pdf.pageNumberFirstValue` and
   * "skip-first" semantics ("page 2 should display 1"), we re-draw the footer
   * page-number text using pdf-lib after PDF generation.
   *
   * Strategy:
   *   - We told Puppeteer to print a sentinel marker `__PAGE_PLACEHOLDER__`
   *     instead of the real page number. (See renderFooterTemplate.)
   *   - Here we walk every page, locate the placeholder area in the footer,
   *     redact it with a white box, and draw the desired page number.
   */
  private async renumberPages(pdfBuffer: Uint8Array): Promise<Uint8Array> {
    const pageNumberMode = this.config.get<string>("pdf.pageNumberStart", "skip-first");
    if (pageNumberMode === "none") {
      return pdfBuffer;
    }

    const firstValue = this.config.get<number>("pdf.pageNumberFirstValue", 1);
    const skipFirst = pageNumberMode === "skip-first";

    const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");
    const pdfDoc = await PDFDocument.load(pdfBuffer);
    const font = await pdfDoc.embedFont(StandardFonts.TimesRoman);

    const pages = pdfDoc.getPages();
    const fontSize = 10;

    pages.forEach((page, idx) => {
      const { width } = page.getSize();

      // skip-first: page 1 (cover) → no number, page 2 → firstValue, ...
      // always:    page 1 → firstValue, page 2 → firstValue + 1, ...
      let displayNumber: number | null;
      if (skipFirst) {
        displayNumber = idx === 0 ? null : firstValue + idx - 1;
      } else {
        displayNumber = firstValue + idx;
      }

      // White-out the area where the original Puppeteer footer was drawn,
      // so the placeholder text disappears.
      page.drawRectangle({
        x: 0,
        y: 4,
        width,
        height: 22,
        color: rgb(1, 1, 1),
      });

      if (displayNumber === null) { return; }

      const text = String(displayNumber);
      const textWidth = font.widthOfTextAtSize(text, fontSize);
      page.drawText(text, {
        x: (width - textWidth) / 2,
        y: 12,
        size: fontSize,
        font,
        color: rgb(0.27, 0.27, 0.27),
      });
    });

    return pdfDoc.save();
  }

  // ──────────────────────────────────────────────
  // Browser launch
  // ──────────────────────────────────────────────

  private async launchBrowser(): Promise<Browser> {
    // Try to find a local Chrome/Chromium installation
    const executablePath = this.findChromiumPath();

    const puppeteer = await import("puppeteer-core");
    return puppeteer.launch({
      executablePath,
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--font-render-hinting=none", // sharper fonts in PDF
      ],
    });
  }

  private findChromiumPath(): string {
    // 1. Check VS Code setting override
    const userPath = this.config.get<string>("pdf.chromiumPath");
    if (userPath && fs.existsSync(userPath)) {
      return userPath;
    }

    // 2. Common platform-specific paths
    const candidates: string[] =
      process.platform === "win32"
        ? [
            "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
            "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
            `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
            "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
          ]
        : process.platform === "darwin"
        ? [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
          ]
        : [
            "/usr/bin/google-chrome",
            "/usr/bin/chromium-browser",
            "/usr/bin/chromium",
          ];

    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }

    // Fallback: let puppeteer-core try to locate it via environment
    return "";
  }

  // ──────────────────────────────────────────────
  // PDF options
  // ──────────────────────────────────────────────

  private buildPdfOptions(_outputPath: string): import("puppeteer-core").PDFOptions {
    const format = this.config.get<string>("pdf.paperFormat", "A4") as
      | "A4"
      | "Letter"
      | "A3";
    const marginTop = this.config.get<string>("pdf.marginTop", "25mm");
    const marginBottom = this.config.get<string>("pdf.marginBottom", "25mm");
    const marginLeft = this.config.get<string>("pdf.marginLeft", "25mm");
    const marginRight = this.config.get<string>("pdf.marginRight", "25mm");
    const pageNumberMode = this.config.get<string>(
      "pdf.pageNumberStart",
      "skip-first"
    );

    const showPageNumbers = pageNumberMode !== "none";

    // path は指定しない: 後処理 (renumberPages) で書き出すため、
    // puppeteer に直接ファイルを書かせると上書きできなくなる
    return {
      format,
      printBackground: true,
      displayHeaderFooter: showPageNumbers,
      headerTemplate: `<div style="font-size:0px;"></div>`, // empty but non-null
      footerTemplate:
        showPageNumbers ? this.renderFooterTemplate(pageNumberMode) : `<div></div>`,
      margin: {
        top: marginTop,
        bottom: marginBottom,
        left: marginLeft,
        right: marginRight,
      },
    };
  }

  // ──────────────────────────────────────────────
  // Footer template with page-number control
  // ──────────────────────────────────────────────
  /**
   * Puppeteer footer/header templates do NOT execute <script> tags. The
   * browser-injected `<span class="pageNumber">` always shows the physical
   * page index. So we draw a placeholder string here, and overwrite it with
   * the desired number in `renumberPages()` (pdf-lib post-processing).
   *
   * The template is intentionally minimal — pdf-lib draws over it anyway.
   */
  private renderFooterTemplate(_mode: string): string {
    return `<div style="
      width:100%;font-size:10pt;font-family:serif;
      color:#fff;text-align:center;padding:4mm 0 2mm;box-sizing:border-box;
    ">.</div>`;
  }

  // ──────────────────────────────────────────────
  // HTML document assembly
  // ──────────────────────────────────────────────

  private buildFullHtml(bodyHtml: string, extraCss: string): string {
    // ── ローカルアセット（CDN 不要・オフライン対応） ──────────────
    const katexCss   = this.toFileUrl("node_modules/katex/dist/katex.min.css");
    const hljsCss    = this.toFileUrl("media/hljs-github.min.css");
    const hljsJs     = this.toFileUrl("media/highlight.min.js");
    const mermaidJs  = this.toFileUrl("media/mermaid.min.js");

    // ページ番号の表示・スキップは renumberPages() の後処理で行うため
    // CSS 側で何かする必要はない
    const skipFirstCss = "";

    return /* html */ `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <title>Academic Markdown Export</title>

  <!-- highlight.js (ローカル) -->
  <link rel="stylesheet" href="${hljsCss}">
  <script src="${hljsJs}"></script>
  <script>document.addEventListener('DOMContentLoaded', function(){ hljs.highlightAll(); });</script>

  <!-- KaTeX CSS (ローカル・フォントも file:// 経由で解決) -->
  <!-- 数式は markdown-it プラグインでサーバーサイドレンダリング済み -->
  <link rel="stylesheet" href="${katexCss}">
  <script>window._katexDone = true;</script>

  <!-- Mermaid (ローカル) -->
  <script src="${mermaidJs}"></script>
  <script>
    function getMermaidApi() {
      if (typeof mermaid === 'undefined') { return null; }
      if (mermaid && typeof mermaid.initialize === 'function' && typeof mermaid.run === 'function') {
        return mermaid;
      }
      if (mermaid && mermaid.default && typeof mermaid.default.initialize === 'function' && typeof mermaid.default.run === 'function') {
        return mermaid.default;
      }
      return null;
    }

    /*
     * Chrome の page.pdf() は <foreignObject> 内 HTML を信頼性低くしか
     * 描画しない。そこで mermaid 描画完了後に foreignObject を SVG <text>
     * 要素に置き換えてから PDF 化する。
     */
    function convertForeignObjectsToSvgText() {
      var SVG_NS = 'http://www.w3.org/2000/svg';
      var fontFamily = '"Hiragino Sans","Yu Gothic","Meiryo",sans-serif';
      var fos = document.querySelectorAll('.mermaid svg foreignObject');

      Array.prototype.forEach.call(fos, function(fo) {
        // 既に処理済み or 子要素なし
        if (!fo.parentNode) { return; }

        // 内部 HTML を行に分解 (<br>, <p>, <div> を改行扱い)
        var lines = [];
        function walk(node, currentLine) {
          if (node.nodeType === 3) {
            // text node
            currentLine.text += node.nodeValue;
            return currentLine;
          }
          if (node.nodeType !== 1) { return currentLine; }
          var tag = node.tagName ? node.tagName.toLowerCase() : '';
          if (tag === 'br') {
            lines.push(currentLine.text);
            return { text: '' };
          }
          var blockTag = (tag === 'p' || tag === 'div');
          if (blockTag && currentLine.text) {
            lines.push(currentLine.text);
            currentLine = { text: '' };
          }
          for (var i = 0; i < node.childNodes.length; i++) {
            currentLine = walk(node.childNodes[i], currentLine);
          }
          if (blockTag && currentLine.text) {
            lines.push(currentLine.text);
            currentLine = { text: '' };
          }
          return currentLine;
        }
        var last = walk(fo, { text: '' });
        if (last.text) { lines.push(last.text); }
        lines = lines
          .map(function(s) { return s.replace(/\\s+/g, ' ').trim(); })
          .filter(function(s) { return s.length > 0; });

        if (!lines.length) {
          var raw = (fo.textContent || '').trim();
          if (raw) { lines = [raw]; }
        }
        if (!lines.length) { return; }

        // foreignObject の位置とサイズ
        var x = parseFloat(fo.getAttribute('x') || '0');
        var y = parseFloat(fo.getAttribute('y') || '0');
        var w = parseFloat(fo.getAttribute('width') || '0');
        var h = parseFloat(fo.getAttribute('height') || '0');

        // フォントサイズの推定: 内側の div の computed style から取得
        var fontSize = 14;
        var inner = fo.querySelector('div, span, p');
        if (inner) {
          var cs = (typeof getComputedStyle === 'function') ? getComputedStyle(inner) : null;
          if (cs) {
            var fs = parseFloat(cs.fontSize);
            if (fs && !isNaN(fs)) { fontSize = fs; }
          }
        }
        var lineHeight = fontSize * 1.2;

        // SVG <text> を生成
        var textEl = document.createElementNS(SVG_NS, 'text');
        textEl.setAttribute('x', String(x + w / 2));
        textEl.setAttribute('y', String(y + h / 2));
        textEl.setAttribute('text-anchor', 'middle');
        textEl.setAttribute('dominant-baseline', 'middle');
        textEl.setAttribute('fill', '#111111');
        textEl.setAttribute('font-family', fontFamily);
        textEl.setAttribute('font-size', String(fontSize));
        textEl.style.fontFamily = fontFamily;

        var totalH = (lines.length - 1) * lineHeight;
        var startY = (y + h / 2) - totalH / 2;

        for (var li = 0; li < lines.length; li++) {
          var tspan = document.createElementNS(SVG_NS, 'tspan');
          tspan.setAttribute('x', String(x + w / 2));
          tspan.setAttribute('y', String(startY + li * lineHeight));
          tspan.textContent = lines[li];
          textEl.appendChild(tspan);
        }

        fo.parentNode.replaceChild(textEl, fo);
      });
    }

    document.addEventListener('DOMContentLoaded', function() {
      var mermaidApi = getMermaidApi();
      if (!mermaidApi) {
        window._mermaidDone = true;
        return;
      }
      mermaidApi.initialize({
        startOnLoad: false,
        theme: 'default',
        // 日本語フォントを明示指定 → mermaid のレイアウト計算と
        // 後段の SVG <text> 変換でフォントが揃う
        fontFamily: '"Hiragino Sans","Yu Gothic","Meiryo",sans-serif',
        securityLevel: 'loose',
        // htmlLabels:true (デフォルト) で foreignObject 内に HTML として
        // ラベルを描画する。直後に SVG <text> へ変換するため、
        // PDF 出力時の foreignObject 描画問題を回避できる。
        flowchart: { htmlLabels: true, useMaxWidth: true },
        sequence: { useMaxWidth: true },
        gantt: { useMaxWidth: true },
      });
      var nodes = Array.prototype.slice.call(
        document.querySelectorAll('div.mermaid')
      );
      if (!nodes.length) { window._mermaidDone = true; return; }
      mermaidApi.run({ nodes: nodes })
        .then(function() {
          try { convertForeignObjectsToSvgText(); }
          catch (e) { console.error('foreignObject -> text conversion error:', e); }
          window._mermaidDone = true;
        })
        .catch(function(e) {
          console.error('mermaid.run error:', e);
          try { convertForeignObjectsToSvgText(); } catch (_) {}
          window._mermaidDone = true;
        });
    });
  </script>

  <style>
    @page {
      size: ${this.config.get("pdf.paperFormat", "A4")};
      margin: ${this.config.get("pdf.marginTop", "25mm")}
              ${this.config.get("pdf.marginRight", "25mm")}
              ${this.config.get("pdf.marginBottom", "25mm")}
              ${this.config.get("pdf.marginLeft", "25mm")};
    }
    ${skipFirstCss}

    .cover-page { page-break-after: always; }

    body {
      font-family: "Hiragino Mincho ProN","Yu Mincho","MS Mincho",Georgia,serif;
      font-size: 11pt; line-height: 1.8; color: #111; max-width: none;
    }
    h1,h2,h3,h4,h5,h6 {
      font-family: "Hiragino Sans","Yu Gothic","Meiryo",sans-serif;
      page-break-after: avoid;
    }
    figure { margin:1.5em auto; text-align:center; page-break-inside:avoid; }
    figure img { max-width:100%; }
    figcaption,.caption { font-size:0.9em; color:#333; margin-top:0.4em; text-align:center; }

    /* listing: figcaption is above the code block */
    figure.listing { text-align:left; page-break-inside:avoid; }
    figure.listing figcaption.listing-caption {
      font-size:0.88em; font-style:italic; color:#333;
      background:#e8e8f0; border:1px solid #d0d0e0;
      border-bottom:none; border-radius:4px 4px 0 0;
      padding:0.3em 0.9em; margin:0;
    }
    figure.listing pre { margin:0; border-radius:0 0 4px 4px; }

    /* highlight.js overrides for print */
    pre { font-size:0.88em; line-height:1.6; page-break-inside:avoid; }
    code { font-family:"Fira Code","Consolas",monospace; }

    .equation-block { display:flex; align-items:center; position:relative; margin:1.2em 0; }
    .equation-content { flex:1; text-align:center; }
    .equation-number { position:absolute; right:0; font-size:0.9em; color:#444; }

    .toc { background:#f9f9f9; border:1px solid #ddd; border-radius:4px;
           padding:1em 1.5em; margin:1.5em 0; page-break-after:always; }
    .toc-title { font-size:1.1em; margin-top:0;
                 border-bottom:1px solid #ccc; padding-bottom:0.3em; }
    .toc ul { list-style:none; padding-left:1.2em; margin:0.3em 0; }
    .toc>ul { padding-left:0; }
    .toc a { color:#2a5db0; text-decoration:none; }

    table { border-collapse:collapse; width:100%; margin:0.8em 0; page-break-inside:avoid; }
    th,td { border:1px solid #999; padding:0.4em 0.7em; text-align:left; }
    th { background:#e8e8e8; }

    /* Mermaid SVG テキスト強制表示 (htmlLabels:true / false の両方に対応) */
    .mermaid { page-break-inside: avoid; }
    .mermaid svg { max-width: 100%; }
    .mermaid svg text,
    .mermaid svg tspan {
      fill: #111111 !important;
      opacity: 1 !important;
      visibility: visible !important;
    }
    .mermaid svg .label text,
    .mermaid svg .label tspan,
    .mermaid svg .cluster-label text {
      fill: #111111 !important;
    }
    .mermaid svg .edgeLabel text,
    .mermaid svg .edgeLabel tspan {
      fill: #111111 !important;
    }
    .mermaid svg .edgeLabel rect,
    .mermaid svg .labelBkg {
      fill: #ffffff !important;
    }
    /* htmlLabels:true 時の foreignObject 内 HTML ラベル */
    .mermaid svg foreignObject,
    .mermaid svg foreignObject div,
    .mermaid svg foreignObject span,
    .mermaid svg foreignObject p {
      color: #111111 !important;
      fill: #111111 !important;
      font-family: "Hiragino Sans","Yu Gothic","Meiryo",sans-serif !important;
      overflow: visible !important;
    }
    .mermaid svg .nodeLabel,
    .mermaid svg .edgeLabel {
      color: #111111 !important;
      background-color: #ffffff;
    }

    /* 手動ページ区切り (---) は PDF では非表示・強制改ページ扱い */
    .manual-pagebreak {
      display: block !important;
      height: 0 !important;
      overflow: hidden !important;
      margin: 0 !important;
      padding: 0 !important;
      background: transparent !important;
      border: none !important;
      page-break-after: always !important;
      break-after: page !important;
    }
    .manual-pagebreak::after,
    .manual-pagebreak::before { content: none !important; }
    .acad-page-sep { display: none !important; }
  </style>

  <style>${extraCss}</style>
</head>
<body data-pdf-export="true">
${bodyHtml}
</body>
</html>`;
  }

  // ──────────────────────────────────────────────
  // Wait for math rendering
  // ──────────────────────────────────────────────

  private async waitForRender(page: Page): Promise<void> {
    // Mermaid ダイアグラムのレンダリング完了を待つ
    await page
      .waitForFunction(() => (globalThis as Record<string, unknown>)["_mermaidDone"] === true, {
        timeout: 15_000,
      })
      .catch(() => {});

    // フォントの読み込み完了を待つ (foreignObject 内ラベルの描画安定化)
    await page
      .evaluate(() => {
        const doc = (globalThis as Record<string, unknown>)["document"] as
          | { fonts?: { ready: Promise<unknown> } }
          | undefined;
        return doc?.fonts?.ready;
      })
      .catch(() => {});

    // highlight.js・SVGフォント解決・その他の同期処理が終わるまで待つ
    await page.evaluate(() => new Promise<void>((r) => setTimeout(r, 500)));
  }
}
