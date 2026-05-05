import * as vscode from "vscode";

export class AcademicSidebarProvider implements vscode.WebviewViewProvider {
  static readonly viewId = "academic-md.sidebar";
  private _view?: vscode.WebviewView;

  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _ctx: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };
    webviewView.webview.html = this.buildHtml(webviewView.webview);
    webviewView.webview.onDidReceiveMessage(this.onMessage.bind(this));

    // 設定変更をサイドバーに通知
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("academic-md")) {
        this.pushConfig(webviewView.webview);
      }
    });
  }

  // ── メッセージハンドラ ─────────────────────────────────────────

  private onMessage(msg: { command: string; key?: string; value?: unknown }): void {
    switch (msg.command) {
      case "setSetting":
        if (msg.key !== undefined) {
          vscode.workspace
            .getConfiguration("academic-md")
            .update(msg.key, msg.value, vscode.ConfigurationTarget.Global);
        }
        break;
      case "requestConfig":
        if (this._view) { this.pushConfig(this._view.webview); }
        break;
      default:
        vscode.commands.executeCommand(`academic-md.${msg.command}`);
    }
  }

  private pushConfig(webview: vscode.Webview): void {
    const cfg = vscode.workspace.getConfiguration("academic-md");
    webview.postMessage({
      command: "config",
      data: {
        "numbering.sections":          cfg.get("numbering.sections", true),
        "numbering.sectionBaseLevel":  cfg.get("numbering.sectionBaseLevel", "h2"),
        "toc.maxDepth":                cfg.get("toc.maxDepth", 3),
        "pdf.pageNumberStart":         cfg.get("pdf.pageNumberStart", "skip-first"),
        "pdf.pageNumberFirstValue":    cfg.get("pdf.pageNumberFirstValue", 1),
        "pdf.paperFormat":             cfg.get("pdf.paperFormat", "A4"),
        "pdf.marginTop":               cfg.get("pdf.marginTop", "25mm"),
        "pdf.marginBottom":            cfg.get("pdf.marginBottom", "25mm"),
        "pdf.marginLeft":              cfg.get("pdf.marginLeft", "25mm"),
        "pdf.marginRight":             cfg.get("pdf.marginRight", "25mm"),
        "pdf.customCssPath":           cfg.get("pdf.customCssPath", ""),
      },
    });
  }

  // ── HTML ──────────────────────────────────────────────────────

  private buildHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "sidebar.css")
    );
    return /* html */ `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
             style-src ${webview.cspSource};
             script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${styleUri}">
</head>
<body>

<!-- ── タブバー ── -->
<div class="tab-bar">
  <button class="tab active" data-tab="quick">クイック</button>
  <button class="tab" data-tab="insert">挿入</button>
  <button class="tab" data-tab="numbering">採番</button>
  <button class="tab" data-tab="pdf">PDF</button>
</div>

<!-- ── クイック ── -->
<div class="tab-panel active" id="tab-quick">
  <button class="action-btn primary" data-cmd="exportPdf">
    <svg viewBox="0 0 16 16"><path d="M4 1h6l4 4v10H2V1h2zm5 0v4h4M5 9h6M5 11h4"/></svg>
    PDF エクスポート
  </button>
  <button class="action-btn" data-cmd="openPreview">
    <svg viewBox="0 0 16 16"><path d="M1 8s3-5 7-5 7 5 7 5-3 5-7 5-7-5-7-5z"/><circle cx="8" cy="8" r="2"/></svg>
    プレビューを開く
  </button>
  <div class="sep"></div>
  <button class="action-btn" data-cmd="insertToc">
    <svg viewBox="0 0 16 16"><path d="M2 4h12M2 8h8M2 12h10"/></svg>
    目次 [TOC] を挿入
  </button>
  <button class="action-btn" data-cmd="insertFigure">
    <svg viewBox="0 0 16 16"><rect x="1" y="3" width="14" height="10" rx="1"/><path d="M1 10l4-4 3 3 2-2 5 4"/><circle cx="11" cy="6" r="1.5"/></svg>
    図のキャプション挿入
  </button>
  <button class="action-btn" data-cmd="insertTable">
    <svg viewBox="0 0 16 16"><rect x="1" y="2" width="14" height="12" rx="1"/><path d="M1 6h14M5 6v8M5 2v4"/></svg>
    表のキャプション挿入
  </button>
  <button class="action-btn" data-cmd="insertListing">
    <svg viewBox="0 0 16 16"><rect x="1" y="2" width="14" height="12" rx="1"/><path d="M4 6l3 3-3 3M8 12h4"/></svg>
    コードリスト挿入
  </button>
</div>

<!-- ── 挿入 ── -->
<div class="tab-panel" id="tab-insert">
  <p class="hint">カーソル位置にスニペットを挿入します。</p>

  <div class="group-title">図</div>
  <button class="action-btn" data-cmd="insertFigure">
    <svg viewBox="0 0 16 16"><rect x="1" y="3" width="14" height="10" rx="1"/><path d="M1 10l4-4 3 3 2-2 5 4"/><circle cx="11" cy="6" r="1.5"/></svg>
    図のキャプション
  </button>

  <div class="group-title">表</div>
  <button class="action-btn" data-cmd="insertTable">
    <svg viewBox="0 0 16 16"><rect x="1" y="2" width="14" height="12" rx="1"/><path d="M1 6h14M5 6v8M5 2v4"/></svg>
    表のキャプション + テンプレート
  </button>

  <div class="group-title">コード</div>
  <button class="action-btn" data-cmd="insertListing">
    <svg viewBox="0 0 16 16"><rect x="1" y="2" width="14" height="12" rx="1"/><path d="M4 6l3 3-3 3M8 12h4"/></svg>
    コードリスト
  </button>

  <div class="group-title">目次</div>
  <button class="action-btn" data-cmd="insertToc">
    <svg viewBox="0 0 16 16"><path d="M2 4h12M2 8h8M2 12h10"/></svg>
    [TOC] マーカー
  </button>
</div>

<!-- ── 採番 ── -->
<div class="tab-panel" id="tab-numbering">

  <div class="group-title">章番号</div>

  <div class="setting-row">
    <label>章番号を自動付与</label>
    <input type="checkbox" id="chk-sections" data-key="numbering.sections">
  </div>

  <div class="setting-row">
    <label>先頭レベル</label>
    <select id="sel-base-level" data-key="numbering.sectionBaseLevel">
      <option value="h1">h1 から（# → 1）</option>
      <option value="h2">h2 から（# は無番号）</option>
    </select>
  </div>

  <div class="sep"></div>
  <div class="group-title">目次</div>

  <div class="setting-row">
    <label>表示する最大レベル</label>
    <select id="sel-toc-depth" data-key="toc.maxDepth">
      <option value="1">h1 のみ</option>
      <option value="2">h1–h2</option>
      <option value="3">h1–h3</option>
      <option value="4">h1–h4</option>
      <option value="5">h1–h5</option>
      <option value="6">h1–h6</option>
    </select>
  </div>

  <div class="sep"></div>
  <div class="group-title">図 / 表 / 数式</div>

  <div class="setting-row">
    <label>図を採番</label>
    <input type="checkbox" id="chk-figures" data-key="numbering.figures">
  </div>
  <div class="setting-row">
    <label>表を採番</label>
    <input type="checkbox" id="chk-tables" data-key="numbering.tables">
  </div>
  <div class="setting-row">
    <label>コードリストを採番</label>
    <input type="checkbox" id="chk-listings" data-key="numbering.listings">
  </div>
  <div class="setting-row">
    <label>数式を採番</label>
    <input type="checkbox" id="chk-equations" data-key="numbering.equations">
  </div>
</div>

<!-- ── PDF ── -->
<div class="tab-panel" id="tab-pdf">

  <div class="group-title">ページ番号</div>

  <div class="setting-row">
    <label>表示モード</label>
    <select id="sel-pagenum" data-key="pdf.pageNumberStart">
      <option value="skip-first">表紙は非表示</option>
      <option value="always">常に表示</option>
      <option value="none">非表示</option>
    </select>
  </div>

  <div class="setting-row">
    <label>先頭ページ番号</label>
    <input type="number" id="num-first-page" min="0" max="99"
           data-key="pdf.pageNumberFirstValue" style="width:56px">
  </div>

  <div class="sep"></div>
  <div class="group-title">用紙</div>

  <div class="setting-row">
    <label>用紙サイズ</label>
    <select id="sel-paper" data-key="pdf.paperFormat">
      <option value="A4">A4</option>
      <option value="Letter">Letter</option>
      <option value="A3">A3</option>
    </select>
  </div>

  <div class="sep"></div>
  <div class="group-title">余白</div>

  <div class="setting-row"><label>上</label>
    <input type="text" id="txt-margin-top"    data-key="pdf.marginTop"    class="txt-margin">
  </div>
  <div class="setting-row"><label>下</label>
    <input type="text" id="txt-margin-bottom" data-key="pdf.marginBottom" class="txt-margin">
  </div>
  <div class="setting-row"><label>左</label>
    <input type="text" id="txt-margin-left"   data-key="pdf.marginLeft"   class="txt-margin">
  </div>
  <div class="setting-row"><label>右</label>
    <input type="text" id="txt-margin-right"  data-key="pdf.marginRight"  class="txt-margin">
  </div>

  <div class="sep"></div>
  <div class="group-title">カスタム CSS</div>

  <input type="text" id="txt-custom-css" data-key="pdf.customCssPath"
         placeholder="絶対パス（空欄=なし）" class="txt-full">
</div>

<script nonce="${nonce}">
(function() {
  const vscode = acquireVsCodeApi();

  // ── タブ切り替え ─────────────────────────────────────
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
      vscode.setState({ ...vscode.getState(), activeTab: tab.dataset.tab });
    });
  });

  // ── ボタン → コマンド ─────────────────────────────────
  document.querySelectorAll('.action-btn[data-cmd]').forEach(btn => {
    btn.addEventListener('click', () => vscode.postMessage({ command: btn.dataset.cmd }));
  });

  // ── 設定コントロール → VS Code 設定更新 ───────────────

  function sendSetting(key, value) {
    vscode.postMessage({ command: 'setSetting', key, value });
  }

  // チェックボックス
  document.querySelectorAll('input[type=checkbox][data-key]').forEach(el => {
    el.addEventListener('change', () => sendSetting(el.dataset.key, el.checked));
  });

  // セレクトボックス
  document.querySelectorAll('select[data-key]').forEach(el => {
    el.addEventListener('change', () => {
      const v = el.tagName === 'SELECT' && el.options[el.selectedIndex]
        ? (isNaN(Number(el.value)) ? el.value : Number(el.value))
        : el.value;
      sendSetting(el.dataset.key, v);
    });
  });

  // 数値・テキスト入力
  document.querySelectorAll('input[type=number][data-key], input[type=text][data-key]').forEach(el => {
    el.addEventListener('change', () => {
      const v = el.type === 'number' ? Number(el.value) : el.value;
      sendSetting(el.dataset.key, v);
    });
  });

  // ── VS Code からの設定同期 ────────────────────────────

  window.addEventListener('message', e => {
    if (!e.data || e.data.command !== 'config') return;
    const d = e.data.data;

    // チェックボックス
    document.querySelectorAll('input[type=checkbox][data-key]').forEach(el => {
      if (d[el.dataset.key] !== undefined) el.checked = !!d[el.dataset.key];
    });
    // セレクト
    document.querySelectorAll('select[data-key]').forEach(el => {
      if (d[el.dataset.key] !== undefined) el.value = String(d[el.dataset.key]);
    });
    // テキスト / 数値
    document.querySelectorAll('input[type=text][data-key], input[type=number][data-key]').forEach(el => {
      if (d[el.dataset.key] !== undefined) el.value = d[el.dataset.key];
    });
  });

  // ── 初期化 ───────────────────────────────────────────

  // タブ状態を復元
  const savedTab = (vscode.getState() || {}).activeTab;
  if (savedTab) {
    const btn = document.querySelector('.tab[data-tab="' + savedTab + '"]');
    if (btn) btn.click();
  }

  // 設定値を要求
  vscode.postMessage({ command: 'requestConfig' });
})();
</script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let t = "";
  const c = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) { t += c.charAt(Math.floor(Math.random() * c.length)); }
  return t;
}
