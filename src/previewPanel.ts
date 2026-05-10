import * as path from "path";
import * as vscode from "vscode";

type RenderMarkdown = (markdown: string, sourcePath: string) => Promise<string>;

export class AcademicPreviewPanel {
  private static current: AcademicPreviewPanel | undefined;

  private document: vscode.TextDocument;
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private renderTimer: ReturnType<typeof setTimeout> | undefined;
  private renderVersion = 0;

  static open(
    extensionUri: vscode.Uri,
    editor: vscode.TextEditor,
    renderMarkdown: RenderMarkdown
  ): void {
    if (AcademicPreviewPanel.current) {
      AcademicPreviewPanel.current.reveal(editor.document);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "academicMarkdownPreview",
      `Academic Preview: ${editor.document.fileName.split(/[/\\]/).pop() ?? "Markdown"}`,
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      }
    );

    AcademicPreviewPanel.current = new AcademicPreviewPanel(panel, extensionUri, editor.document, renderMarkdown);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    document: vscode.TextDocument,
    private readonly renderMarkdown: RenderMarkdown
  ) {
    this.panel = panel;
    this.document = document;

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.document.uri.toString() === this.document.uri.toString()) {
          this.scheduleRender();
        }
      })
    );

    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor?.document.languageId === "markdown") {
          this.reveal(editor.document);
        }
      })
    );

    this.scheduleRender(0);
  }

  dispose(): void {
    AcademicPreviewPanel.current = undefined;
    if (this.renderTimer) {
      clearTimeout(this.renderTimer);
    }
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }

  private reveal(document: vscode.TextDocument): void {
    this.document = document;
    this.panel.title = `Academic Preview: ${path.basename(document.fileName)}`;
    this.panel.reveal(vscode.ViewColumn.Beside, true);
    this.scheduleRender(0);
  }

  private scheduleRender(delay = 250): void {
    if (this.renderTimer) {
      clearTimeout(this.renderTimer);
    }
    this.renderTimer = setTimeout(() => {
      void this.render();
    }, delay);
  }

  private async render(): Promise<void> {
    const version = ++this.renderVersion;
    const document = this.document;

    this.panel.webview.options = {
      enableScripts: true,
      localResourceRoots: this.getLocalResourceRoots(document.uri),
    };

    const bodyHtml = await this.renderMarkdown(document.getText(), document.uri.fsPath);
    if (version !== this.renderVersion) {
      return;
    }

    this.panel.webview.html = this.buildHtml(bodyHtml, document.uri);
  }

  private getLocalResourceRoots(documentUri: vscode.Uri): vscode.Uri[] {
    const roots = [this.extensionUri, vscode.Uri.file(path.dirname(documentUri.fsPath))];
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      roots.push(folder.uri);
    }
    return roots;
  }

  private buildHtml(bodyHtml: string, documentUri: vscode.Uri): string {
    const webview = this.panel.webview;
    const nonce = getNonce();
    const assetVersion = String(this.renderVersion);

    function withVersion(uri: vscode.Uri): string {
      return `${uri.toString()}?v=${assetVersion}`;
    }

    const styleUri = withVersion(webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "style.css")));
    const hljsCssUri = withVersion(webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "hljs-github.min.css")));
    const hljsJsUri = withVersion(webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "highlight.min.js")));
    const mermaidJsUri = withVersion(webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "mermaid.min.js")));
    const mermaidInitUri = withVersion(webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "mermaid-init.js")));
    const previewJsUri = withVersion(webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "preview.js")));
    const katexCssUri = withVersion(webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "node_modules", "katex", "dist", "katex.min.css")));
    const baseUri = webview.asWebviewUri(vscode.Uri.file(path.dirname(documentUri.fsPath))).toString().replace(/\/?$/, "/");

    return /* html */ `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="light">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
             img-src ${webview.cspSource} data: https:;
             font-src ${webview.cspSource} data:;
             style-src ${webview.cspSource} 'unsafe-inline';
             script-src ${webview.cspSource} 'nonce-${nonce}' 'unsafe-eval';
             base-uri ${webview.cspSource};">
  <base href="${baseUri}">
  <title>${escapeHtml(path.basename(documentUri.fsPath))}</title>
  <link rel="stylesheet" href="${styleUri}">
  <link rel="stylesheet" href="${hljsCssUri}">
  <link rel="stylesheet" href="${katexCssUri}">
  <style>
    :root {
      color-scheme: light;
    }
    html {
      background: #2b2b2b;
    }
    body {
      margin: 0;
      min-height: 100vh;
      background: #2b2b2b;
      color: #111;
      padding: 32px 24px 64px;
    }
    .markdown-body {
      max-width: 860px;
      margin: 0 auto;
      background: #ffffff;
      color: #111111;
      box-shadow: 0 18px 48px rgba(0, 0, 0, 0.28);
      border: 1px solid #d8d8d8;
    }
    .markdown-body h1,
    .markdown-body h2,
    .markdown-body h3,
    .markdown-body h4,
    .markdown-body h5,
    .markdown-body h6,
    .markdown-body p,
    .markdown-body li,
    .markdown-body blockquote,
    .markdown-body figcaption,
    .markdown-body .table-caption,
    .markdown-body .equation-number,
    .markdown-body .toc-title,
    .markdown-body .toc a,
    .markdown-body code,
    .markdown-body pre,
    .markdown-body th,
    .markdown-body td {
      color: #111111;
    }
    .markdown-body h1,
    .markdown-body h2 {
      border-color: #777777;
    }
    .markdown-body th {
      background: #efefef;
    }
    .markdown-body tr:nth-child(even) td {
      background: #fafafa;
    }
    .markdown-body blockquote {
      background: #f7f7f7;
      border-left-color: #8a8a8a;
    }
    .markdown-body figure.listing,
    .markdown-body pre,
    .markdown-body code {
      background: #f6f6f6;
      border-color: #d0d0d0;
    }
    .markdown-body figure.listing figcaption.listing-caption {
      background: #ececec;
      border-bottom-color: #d0d0d0;
    }
    .markdown-body .toc {
      background: #fafafa;
      border-color: #d0d0d0;
    }
    .markdown-body .mermaid svg {
      background: transparent;
    }
    .markdown-body .mermaid svg text,
    .markdown-body .mermaid svg tspan,
    .markdown-body .mermaid svg .label,
    .markdown-body .mermaid svg .label text,
    .markdown-body .mermaid svg .cluster-label text,
    .markdown-body .mermaid svg .nodeLabel,
    .markdown-body .mermaid svg .edgeLabel,
    .markdown-body .mermaid svg .edgeLabel p,
    .markdown-body .mermaid svg foreignObject,
    .markdown-body .mermaid svg foreignObject div,
    .markdown-body .mermaid svg foreignObject span {
      color: #111111 !important;
      fill: #111111 !important;
    }
    .markdown-body .mermaid svg .edgeLabel rect,
    .markdown-body .mermaid svg .labelBkg {
      fill: #ffffff !important;
    }
  </style>
</head>
<body data-preview-mode="print">
  <article class="markdown-body" data-mermaid-theme="print">
${bodyHtml}
  </article>
  <script nonce="${nonce}" src="${hljsJsUri}"></script>
  <script nonce="${nonce}" src="${mermaidJsUri}"></script>
  <script nonce="${nonce}" src="${mermaidInitUri}"></script>
  <script nonce="${nonce}" src="${previewJsUri}"></script>
  <script nonce="${nonce}">
    document.addEventListener("DOMContentLoaded", function () {
      if (typeof hljs !== "undefined") {
        hljs.highlightAll();
      }
    });
  </script>
</body>
</html>`;
  }
}

function getNonce(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";
  for (let index = 0; index < 16; index += 1) {
    nonce += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return nonce;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;");
}