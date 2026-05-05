/**
 * Academic Markdown — preview page-break simulator
 *
 * VS Code の markdown プレビューは .markdown-body にコンテンツを入れる。
 * 各トップレベル要素の offsetTop を使って A4 ページ境界を計算し、
 * 境界を超えたところにページ区切りバーを挿入する。
 * また .manual-pagebreak (---) を検出したらそこで強制改ページ扱いにする。
 */
(function () {
  "use strict";

  /* ── 定数 ────────────────────────────────────── */
  var MM_PX        = 96 / 25.4;                              // 1mm → px
  var CONTENT_H_PX = (297 - 25 - 25) * MM_PX;              // A4 本文高さ ≈ 932px
  var SEP_CLASS    = "acad-page-sep";

  var inserted = [];
  var timer    = null;

  /* ── ユーティリティ ──────────────────────────── */

  function clearSeparators() {
    inserted.forEach(function (el) {
      if (el.parentNode) { el.parentNode.removeChild(el); }
    });
    inserted = [];
  }

  function makeSeparator(pageNum) {
    var wrapper = document.createElement("div");
    wrapper.className = SEP_CLASS;

    var label = document.createElement("div");
    label.className = "acad-page-label";
    label.textContent = pageNum + " ページ目";

    var bar = document.createElement("div");
    bar.className = "acad-page-bar";

    wrapper.appendChild(label);
    wrapper.appendChild(bar);
    return wrapper;
  }

  /* コンテナを取得（VS Code preview は .markdown-body を使う） */
  function getContainer() {
    return (
      document.querySelector(".markdown-body") ||
      document.querySelector("[data-vscode-markdown-body]") ||
      document.body
    );
  }

  /**
   * 要素の「コンテナ上端からの距離」を返す。
   * getBoundingClientRect は scroll 位置に依存するので
   * scrollY を足して絶対 Y 座標に変換し、コンテナ上端を引く。
   */
  function topOf(el, containerAbsTop) {
    return el.getBoundingClientRect().top + window.pageYOffset - containerAbsTop;
  }

  /* ── メイン処理 ──────────────────────────────── */

  function insertBreaks() {
    clearSeparators();

    var container = getContainer();
    if (!container) { return; }

    var containerRect = container.getBoundingClientRect();
    var containerAbsTop = containerRect.top + window.pageYOffset;

    /* セパレータ・手動区切り以外の子要素を収集 */
    var children = Array.prototype.slice.call(container.children).filter(function (el) {
      return !el.classList.contains(SEP_CLASS);
    });

    if (!children.length) { return; }

    var boundary = CONTENT_H_PX;   // 次のページ境界（コンテナ上端からの px）
    var pageNum  = 1;               // 現在のページ番号

    for (var i = 0; i < children.length; i++) {
      var el    = children[i];
      var elTop = topOf(el, containerAbsTop);
      var elBot = elTop + el.offsetHeight;

      /* --- による手動ページ区切りはそこでリセット */
      if (el.classList.contains("manual-pagebreak")) {
        pageNum++;
        boundary = elBot + CONTENT_H_PX;
        continue;
      }

      /* 要素の上端がページ境界を超えていたら区切りを挿入 */
      if (elTop >= boundary - 4) {
        var sep = makeSeparator(pageNum + 1);
        container.insertBefore(sep, el);
        inserted.push(sep);
        pageNum++;
        boundary = elTop + CONTENT_H_PX;
      } else if (elBot > boundary + 50) {
        /* 要素がページをまたぐ → 境界をその要素の下端の先に移動 */
        boundary = elBot + CONTENT_H_PX;
        pageNum++;
      }
    }
  }

  function schedule() {
    if (timer) { clearTimeout(timer); }
    timer = setTimeout(insertBreaks, 400);
  }

  /* ── 起動 ────────────────────────────────────── */

  function init() {
    schedule();
    setupObserver();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  /* VS Code がプレビューを更新したとき（postMessage で通知が来る） */
  window.addEventListener("message", function () { schedule(); });

  /* DOM の変化（KaTeX レンダリング等の完了後）にも追従 */
  function setupObserver() {
    var container = getContainer();
    if (!container) { return; }

    var obs = new MutationObserver(function (mutations) {
      var significant = mutations.some(function (m) {
        return Array.prototype.some.call(m.addedNodes, function (n) {
          return n.nodeType === 1 && !n.classList.contains(SEP_CLASS);
        });
      });
      if (significant) { schedule(); }
    });

    obs.observe(container, { childList: true, subtree: false });
  }

}());
