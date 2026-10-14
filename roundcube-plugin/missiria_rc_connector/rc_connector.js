/* MISSIRIA RC Connector — settings page behaviour (copy token, confirm revoke) */
(function () {
  function ready(fn) {
    if (document.readyState !== 'loading') fn();
    else document.addEventListener('DOMContentLoaded', fn);
  }
  ready(function () {
    document.querySelectorAll('[data-copy]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var el = document.querySelector(btn.getAttribute('data-copy'));
        if (!el) return;
        var text = el.textContent.trim();
        var done = function () { btn.textContent = btn.getAttribute('data-copied') || 'Copied'; };
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done);
        else {
          var r = document.createRange(); r.selectNodeContents(el);
          var s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
          try { document.execCommand('copy'); done(); } catch (e) { /* ignore */ }
        }
      });
    });
    document.querySelectorAll('[data-confirm]').forEach(function (btn) {
      btn.addEventListener('click', function (ev) {
        if (!window.confirm(btn.getAttribute('data-confirm'))) ev.preventDefault();
      });
    });
  });
})();
