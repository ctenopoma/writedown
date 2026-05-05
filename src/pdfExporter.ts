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

  constructor() {
    this.config = vscode.workspace.getConfiguration("academic-md");
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

    const html = this.buildFullHtml(options.htmlContent, customCss);

    let browser: Browser | undefined;
    try {
      browser = await this.launchBrowser();
      const page = await browser.newPage();

      await page.setContent(html, { waitUntil: "networkidle0" });

      // Let MathJax / KaTeX finish rendering
      await this.waitForMath(page);

      const pdfBuffer = await page.pdf(this.buildPdfOptions(outputPath));

      fs.writeFileSync(outputPath, pdfBuffer);
      return outputPath;
    } finally {
      await browser?.close();
    }
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

  private buildPdfOptions(outputPath: string): import("puppeteer-core").PDFOptions {
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

    return {
      path: outputPath,
      format,
      printBackground: true,
      displayHeaderFooter: showPageNumbers,
      headerTemplate: `<div style="font-size:0px;"></div>`, // empty but non-null
      footerTemplate:
        showPageNumbers ? this.renderFooterTemplate(pageNumberMode) : `<div></div>`,
      margin: {
        top: marginTop,
        bottom: showPageNumbers ? marginBottom : marginBottom,
        left: marginLeft,
        right: marginRight,
      },
    };
  }

  // ──────────────────────────────────────────────
  // Footer template with page-number control
  // ──────────────────────────────────────────────
  /**
   * Puppeteer footer/header templates do NOT execute <script> tags (by design,
   * as of Puppeteer v14+). <span class="pageNumber"> is auto-populated by the
   * browser's print engine before the template frame is painted.
   *
   * "skip-first" strategy: inject `@page :first { margin-bottom: 5mm }` into
   * the document CSS (see buildFullHtml). Chrome respects @page :first during
   * print, so the first page gets a 5 mm bottom margin — too small for the
   * footer (which needs ~10 mm) — causing it to be clipped. Pages 2+ use the
   * normal margin and show page numbers as usual.
   *
   * Note: page 2 will display "2", not "1". Renumbering requires PDF
   * post-processing (e.g. pdf-lib) which is outside this extension's scope.
   */
  private renderFooterTemplate(_mode: string): string {
    return `<div style="
      width:100%;font-size:10pt;font-family:serif;
      color:#444;text-align:center;padding:4mm 0 2mm;box-sizing:border-box;
    "><span class="pageNumber"></span></div>`;
  }

  // ──────────────────────────────────────────────
  // HTML document assembly
  // ──────────────────────────────────────────────

  private buildFullHtml(bodyHtml: string, extraCss: string): string {
    const katexCdn = "https://cdn.jsdelivr.net/npm/katex@0.16.9/dist";
    const hljsCdn  = "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0";

    const pageNumberMode = this.config.get<string>("pdf.pageNumberStart", "skip-first");
    // @page :first shrinks the first page's bottom margin so the Puppeteer
    // footer (needs ~10 mm) is clipped — effectively hiding it on the cover.
    const skipFirstCss = pageNumberMode === "skip-first"
      ? "@page :first { margin-bottom: 5mm !important; }"
      : "";

    return /* html */ `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <title>Academic Markdown Export</title>

  <!-- highlight.js: syntax highlighting for code blocks (runs synchronously on DOMContentLoaded) -->
  <link rel="stylesheet" href="${hljsCdn}/styles/github.min.css">
  <script src="${hljsCdn}/highlight.min.js"></script>
  <script>document.addEventListener('DOMContentLoaded', function(){ hljs.highlightAll(); });</script>

  <!-- KaTeX: math rendering -->
  <link rel="stylesheet" href="${katexCdn}/katex.min.css">
  <script defer src="${katexCdn}/katex.min.js"></script>
  <script defer src="${katexCdn}/contrib/auto-render.min.js"
    onload="renderMathInElement(document.body,{
      delimiters:[
        {left:'$$',right:'$$',display:true},
        {left:'$', right:'$', display:false}
      ]
    }); window._katexDone=true;"></script>

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
  </style>

  <style>${extraCss}</style>
</head>
<body>
${bodyHtml}
</body>
</html>`;
  }

  // ──────────────────────────────────────────────
  // Wait for math rendering
  // ──────────────────────────────────────────────

  private async waitForMath(page: Page): Promise<void> {
    // Wait for KaTeX auto-render to set the _katexDone flag (set in onload of auto-render.min.js)
    await page
      .waitForFunction(() => (globalThis as Record<string, unknown>)["_katexDone"] === true, {
        timeout: 10_000,
      })
      .catch(() => { /* KaTeX not loaded or timed out — proceed anyway */ });

    // If MathJax is present, wait for it
    await page.evaluate(async () => {
      const g = globalThis as Record<string, any>;
      if (typeof g["MathJax"] !== "undefined") {
        await g["MathJax"].startup?.promise;
        await g["MathJax"].typesetPromise?.();
      }
    }).catch(() => {});

    // Small tick for highlight.js (synchronous but scheduled via DOMContentLoaded)
    await page.evaluate(() => new Promise<void>((r) => setTimeout(r, 50)));
  }
}
