/**
 * Academic Markdown — Mermaid diagram renderer for VS Code preview
 *
 * mermaid.min.js はこのスクリプトより先に markdown.previewScripts で読み込まれる。
 * <div class="mermaid"> を検出して SVG に変換し、
 * VS Code テーマ変更・プレビュー更新にも追従する。
 */
(function () {
  "use strict";

  var initialized = false;
  var timer = null;

  function getMermaidApi() {
    if (typeof mermaid === "undefined") { return null; }
    if (mermaid && typeof mermaid.initialize === "function" && typeof mermaid.run === "function") {
      return mermaid;
    }
    if (mermaid && mermaid.default && typeof mermaid.default.initialize === "function" && typeof mermaid.default.run === "function") {
      return mermaid.default;
    }
    return null;
  }

  function cssVar(name, fallback) {
    var value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || fallback;
  }

  function isPrintPreview() {
    return document.body && document.body.getAttribute("data-preview-mode") === "print";
  }

  function isDarkColor(color) {
    var r, g, b;
    var hex = color.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
    if (hex) {
      r = parseInt(hex[1], 16);
      g = parseInt(hex[2], 16);
      b = parseInt(hex[3], 16);
      return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.5;
    }
    var rgb = color.match(/(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
    if (!rgb) { return false; }
    r = Number(rgb[1]);
    g = Number(rgb[2]);
    b = Number(rgb[3]);
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.5;
  }

  function getTheme() {
    if (isPrintPreview()) {
      return "default";
    }
    var background = cssVar("--vscode-editor-background", "rgb(255, 255, 255)");
    if (isDarkColor(background)) {
      return "dark";
    }
    return "default";
  }

  function getThemeVariables() {
    if (isPrintPreview()) {
      return {
        background: "#ffffff",
        primaryColor: "#ffffff",
        primaryTextColor: "#111111",
        primaryBorderColor: "#6f6f6f",
        lineColor: "#4f4f4f",
        textColor: "#111111",
        mainBkg: "#ffffff",
        secondBkg: "#ffffff",
        tertiaryColor: "#f5f5f5",
        clusterBkg: "#fffbe6",
        clusterBorder: "#7a7a7a",
        actorBkg: "#f7f7f7",
        actorBorder: "#7a7a7a",
        actorTextColor: "#111111",
        labelBackground: "#ffffff",
        labelTextColor: "#111111",
        nodeBorder: "#7a7a7a",
        edgeLabelBackground: "#ffffff",
        relationColor: "#4f4f4f",
        signalColor: "#4f4f4f",
        sequenceNumberColor: "#111111",
        activationBorderColor: "#7a7a7a",
        activationBkgColor: "#f0f0f0",
        noteBkgColor: "#fffbe6",
        noteBorderColor: "#7a7a7a",
        noteTextColor: "#111111",
        git0: "#111111",
        git1: "#444444",
        git2: "#777777",
        git3: "#aaaaaa",
        cScale0: "#ffffff",
        cScale1: "#f2f2f2",
        cScale2: "#e6e6e6",
        cScale3: "#d9d9d9",
        pie1: "#111111",
        pie2: "#333333",
        pie3: "#555555",
        pie4: "#777777",
        pie5: "#999999",
        pie6: "#bbbbbb",
        pie7: "#d0d0d0",
        pie8: "#e0e0e0",
        pie9: "#f0f0f0",
        pie10: "#c8c8c8",
        pie11: "#8c8c8c",
        pie12: "#4f4f4f"
      };
    }

    var background = cssVar("--vscode-editor-background", "#ffffff");
    var foreground = cssVar("--vscode-editor-foreground", "#111111");
    var border = cssVar("--vscode-panel-border", cssVar("--vscode-editorWidget-border", "#808080"));
    var accent = cssVar("--vscode-textLink-foreground", "#1a4f9e");
    var muted = cssVar("--vscode-descriptionForeground", foreground);

    return {
      background: background,
      primaryColor: background,
      primaryTextColor: foreground,
      primaryBorderColor: border,
      lineColor: muted,
      textColor: foreground,
      mainBkg: background,
      secondBkg: background,
      tertiaryColor: background,
      clusterBkg: background,
      clusterBorder: border,
      actorBkg: background,
      actorBorder: border,
      actorTextColor: foreground,
      labelBackground: background,
      labelTextColor: foreground,
      nodeBorder: border,
      edgeLabelBackground: background,
      relationColor: muted,
      signalColor: muted,
      sequenceNumberColor: foreground,
      activationBorderColor: border,
      activationBkgColor: background,
      noteBkgColor: background,
      noteBorderColor: border,
      noteTextColor: foreground,
      git0: accent,
      git1: foreground,
      git2: muted,
      git3: border,
      cScale0: background,
      cScale1: accent,
      cScale2: muted,
      cScale3: border,
      pie1: accent,
      pie2: muted,
      pie3: border,
      pie4: foreground,
      pie5: background,
      pie6: accent,
      pie7: muted,
      pie8: border,
      pie9: foreground,
      pie10: background,
      pie11: accent,
      pie12: muted
    };
  }

  function ensureInit() {
    if (initialized) { return; }
    var api = getMermaidApi();
    if (!api) { return; }
    initialized = true;
    api.startOnLoad = false;
    api.initialize({
      startOnLoad: false,
      theme: "base",
      darkMode: getTheme() === "dark",
      themeVariables: getThemeVariables(),
      // PDF 出力側と揃える (日本語対応フォント)
      fontFamily: '"Hiragino Sans","Yu Gothic","Meiryo",sans-serif',
      securityLevel: "loose",
      suppressErrorRendering: false,
      flowchart: {
        // htmlLabels:true (デフォルト) — foreignObject 内に HTML として
        // ラベルを描画する。日本語フォントの折り返しが正しく行われる。
        htmlLabels: true,
        useMaxWidth: true,
      },
    });
  }

  function renderDiagrams() {
    var api = getMermaidApi();
    if (!api) { return; }

    var nodes = Array.prototype.slice.call(
      document.querySelectorAll("div.mermaid:not([data-processed])")
    );
    if (!nodes.length) { return; }

    ensureInit();
    nodes.forEach(function (el, i) {
      console.log("[Academic Markdown] mermaid diagram " + i + ":", JSON.stringify(el.textContent.slice(0, 120)));
    });
    api.run({ nodes: nodes }).catch(function (e) {
      console.error("[Academic Markdown] mermaid.run() error:", e);
      nodes.forEach(function (el) {
        if (el.querySelector("svg")) { return; }
        el.setAttribute("data-processed", "true");
        el.innerHTML = "<pre class=\"mermaid-error\"></pre>";
        var target = el.querySelector(".mermaid-error");
        if (target) {
          target.textContent = String((e && e.message) || e || "Mermaid syntax error");
        }
      });
    });
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(renderDiagrams, 300);
  }

  // Mermaid registers its own DOMContentLoaded handler during script load.
  // Preconfigure it immediately so our settings win before auto-start timing.
  ensureInit();

  /* 起動 */
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", schedule);
  } else {
    schedule();
  }

  /* VS Code プレビュー更新 */
  window.addEventListener("message", schedule);

  /* DOM 変化を監視 */
  function setupObserver() {
    var container = document.querySelector(".markdown-body") || document.body;
    var obs = new MutationObserver(function (mutations) {
      var hasNew = mutations.some(function (m) {
        return Array.prototype.some.call(m.addedNodes, function (n) {
          if (n.nodeType !== 1) { return false; }
          if (n.matches && n.matches("div.mermaid")) { return true; }
          return !!(n.querySelector && n.querySelector("div.mermaid"));
        });
      });
      if (hasNew) { schedule(); }
    });
    obs.observe(container, { childList: true, subtree: true });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", setupObserver);
  } else {
    setupObserver();
  }

}());
