/**
 * Academic Markdown — VS Code extension entry point
 *
 * Activation:
 *  - Registered as a markdown-it plugin via the VS Code Markdown API.
 *  - Commands for PDF export and snippet insertion are registered here.
 */

import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { academicMarkdownPlugin, AcademicPluginOptions } from "./markdownItPlugin";
import { PdfExporter } from "./pdfExporter";
import { AcademicSidebarProvider } from "./sidebarProvider";

// ──────────────────────────────────────────────
// Extension lifecycle
// ──────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext): ReturnType<typeof registerMarkdownItPlugin> {
  // 1. markdown-it plugin (built-in preview integration)
  const plugin = registerMarkdownItPlugin(context);

  // 2. Sidebar WebviewView
  const sidebarProvider = new AcademicSidebarProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(AcademicSidebarProvider.viewId, sidebarProvider)
  );

  // 3. Commands
  context.subscriptions.push(
    vscode.commands.registerCommand("academic-md.exportPdf", exportPdfCommand),
    vscode.commands.registerCommand("academic-md.openPreview", openPreviewCommand),
    vscode.commands.registerCommand("academic-md.insertFigure", insertFigureCommand),
    vscode.commands.registerCommand("academic-md.insertTable", insertTableCommand),
    vscode.commands.registerCommand("academic-md.insertListing", insertListingCommand),
    vscode.commands.registerCommand("academic-md.insertToc", insertTocCommand),
    vscode.commands.registerCommand("academic-md.setSetting", setSettingCommand)
  );

  return plugin;
}

export function deactivate(): void {}

// ──────────────────────────────────────────────
// markdown-it plugin registration
// ──────────────────────────────────────────────

/**
 * VS Code exposes its internal markdown-it instance through the
 * `vscode.markdown-language-features` extension API.  We return a plugin
 * object with an `extendMarkdownIt` function that VS Code calls automatically.
 */
function registerMarkdownItPlugin(_context: vscode.ExtensionContext) {
  return {
    extendMarkdownIt(md: object) {
      try {
        const mdInst = md as import("markdown-it");
        // KaTeX を先に use() → block/inline tokenizer が math_block/math_inline トークンを生成
        // 我々の core rule がその後で math_block を採番レンダリングする
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        mdInst.use(require("@traptitech/markdown-it-katex"), { throwOnError: false });

        academicMarkdownPlugin(mdInst, () => {
          const cfg = vscode.workspace.getConfiguration("academic-md");
          const raw = cfg.get<string>("numbering.sectionBaseLevel", "h2");
          const level = Math.max(1, parseInt(raw.replace(/\D/g, ""), 10) || 2) as AcademicPluginOptions["sectionBaseLevel"];
          return {
            sectionNumbering: cfg.get<boolean>("numbering.sections", true),
            sectionBaseLevel: level,
          };
        });
      } catch (err) {
        console.error("[Academic Markdown] extendMarkdownIt error:", err);
      }
      return md;
    },
  };
}

// ──────────────────────────────────────────────
// PDF export command
// ──────────────────────────────────────────────

async function exportPdfCommand(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== "markdown") {
    vscode.window.showErrorMessage("Academic Markdown: アクティブなMarkdownファイルがありません。");
    return;
  }

  const markdownPath = editor.document.uri.fsPath;

  // Ask the user for the output path
  const defaultOut = markdownPath.replace(/\.(md|markdown)$/i, ".pdf");
  const outputUri = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(defaultOut),
    filters: { PDF: ["pdf"] },
    title: "PDFの出力先を選択",
  });

  if (!outputUri) return; // user cancelled

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Academic Markdown: PDFを生成中…",
      cancellable: false,
    },
    async (progress) => {
      try {
        progress.report({ increment: 10, message: "Markdownをレンダリング中…" });

        // Save the document first
        await editor.document.save();

        // Render Markdown to HTML using VS Code's internal engine
        const rawMarkdown = editor.document.getText();
        const html = await renderMarkdownToHtml(rawMarkdown, markdownPath);

        progress.report({ increment: 40, message: "ブラウザを起動中…" });

        // Load the CSS from the media folder
        const cssPath = path.join(__dirname, "..", "media", "style.css");
        const css = fs.existsSync(cssPath) ? fs.readFileSync(cssPath, "utf-8") : "";

        const exporter = new PdfExporter();
        progress.report({ increment: 30, message: "PDFを書き出し中…" });

        const outPath = await exporter.export({
          markdownPath,
          htmlContent: html,
          outputPath: outputUri.fsPath,
          css,
        });

        progress.report({ increment: 20, message: "完了" });

        const open = "ファイルを開く";
        const result = await vscode.window.showInformationMessage(
          `PDF出力完了: ${path.basename(outPath)}`,
          open
        );
        if (result === open) {
          vscode.env.openExternal(vscode.Uri.file(outPath));
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`PDF出力エラー: ${msg}`);
        console.error("[Academic Markdown] PDF export error:", err);
      }
    }
  );
}

// ──────────────────────────────────────────────
// Markdown → HTML rendering
// ──────────────────────────────────────────────

/**
 * We use markdown-it directly (with our plugin applied) to render the
 * Markdown to HTML for PDF export. This avoids depending on VS Code's
 * internal rendering pipeline which is not accessible from extension code.
 */
async function renderMarkdownToHtml(
  markdown: string,
  _sourcePath: string
): Promise<string> {
  // Dynamic import to avoid bundling issues
  const MarkdownIt = (await import("markdown-it")).default;
  const md = new MarkdownIt({
    html: true,
    linkify: true,
    typographer: true,
  });

  // KaTeX を先に適用（block tokenizer が math_block トークンを生成する）
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    md.use(require("@traptitech/markdown-it-katex"), { throwOnError: false });
  } catch { /* not installed */ }

  // 我々のプラグインを後から適用（core rule で math_block を採番レンダリング）
  const cfg = vscode.workspace.getConfiguration("academic-md");
  const pdfOpts: Partial<AcademicPluginOptions> = {
    sectionNumbering: cfg.get<boolean>("numbering.sections", true),
    sectionBaseLevel: (parseInt(
      (cfg.get<string>("numbering.sectionBaseLevel", "h2")).slice(1), 10
    ) as AcademicPluginOptions["sectionBaseLevel"]),
  };
  academicMarkdownPlugin(md, pdfOpts);

  return md.render(markdown);
}

// ──────────────────────────────────────────────
// Preview command
// ──────────────────────────────────────────────

function openPreviewCommand(): void {
  // VS Code 組み込みの Markdown プレビューをサイドに開く
  vscode.commands.executeCommand("markdown.showPreviewToSide");
}

// ──────────────────────────────────────────────
// Setting update command (called from sidebar webview)
// ──────────────────────────────────────────────

async function setSettingCommand(key: string, value: string): Promise<void> {
  const config = vscode.workspace.getConfiguration("academic-md");
  await config.update(key, value, vscode.ConfigurationTarget.Global);
}

// ──────────────────────────────────────────────
// Snippet insertion commands
// ──────────────────────────────────────────────

async function insertFigureCommand(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;

  const caption = await vscode.window.showInputBox({
    prompt: "図のキャプションを入力してください",
    placeHolder: "例: システム全体のアーキテクチャ",
  });
  if (caption === undefined) return;

  const snippet = new vscode.SnippetString(
    `![${caption || "画像の説明"}](\${1:path/to/image.png} "fig: ${caption || "キャプション"}")\n`
  );
  editor.insertSnippet(snippet);
}

async function insertTableCommand(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;

  const caption = await vscode.window.showInputBox({
    prompt: "表のキャプションを入力してください",
    placeHolder: "例: 実験結果の比較",
  });
  if (caption === undefined) return;

  const snippet = new vscode.SnippetString(
    `<!-- table: ${caption || "キャプション"} -->\n` +
    `| \${1:列1} | \${2:列2} | \${3:列3} |\n` +
    `|------|------|------|\n` +
    `| \${4:データ} | \${5:データ} | \${6:データ} |\n`
  );
  editor.insertSnippet(snippet);
}

async function insertListingCommand(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;

  const caption = await vscode.window.showInputBox({
    prompt: "コードリストのキャプションを入力してください",
    placeHolder: "例: データ前処理スクリプト",
  });
  if (caption === undefined) return;

  const lang = await vscode.window.showInputBox({
    prompt: "プログラミング言語を入力してください",
    placeHolder: "例: python, typescript, bash",
    value: "python",
  });

  const snippet = new vscode.SnippetString(
    `\`\`\`${lang || "python"} listing: ${caption || "キャプション"}\n` +
    `\${1:# コードをここに記述}\n` +
    `\`\`\`\n`
  );
  editor.insertSnippet(snippet);
}

function insertTocCommand(): void {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;

  const snippet = new vscode.SnippetString(`[TOC]\n`);
  editor.insertSnippet(snippet);
}
