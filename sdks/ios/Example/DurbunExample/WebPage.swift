import Foundation

/// The page the web view screen loads from the demo server (`/page`). The Android sample serves the same page.
enum WebPage {
    static let html = #"""
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Web view demo</title>
<style>
  :root { color-scheme: light dark; --accent: #5b4be0; }
  body { font: 16px/1.45 system-ui, -apple-system, sans-serif; margin: 0; padding: 16px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  p { margin: 0 0 16px; opacity: .75; font-size: 14px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  button { font: inherit; font-size: 15px; padding: 10px; border-radius: 8px; border: 1px solid var(--accent);
           background: transparent; color: var(--accent); }
  pre { white-space: pre-wrap; font-size: 13px; background: rgba(91, 75, 224, .08); padding: 10px; border-radius: 8px;
        min-height: 4em; }
</style>
</head>
<body>
<h1>Web view</h1>
<p>These requests and console lines reach the Dürbün Mac app through the web view bridge, marked as coming from
the web view.</p>
<div class="grid">
  <button id="fetch-ok">fetch 200</button>
  <button id="fetch-404">fetch 404</button>
  <button id="xhr-post">XHR POST</button>
  <button id="fetch-fail">fetch failing</button>
  <button id="console">console.*</button>
  <button id="throw">Uncaught error</button>
</div>
<pre id="out"></pre>
<script>
  var out = document.getElementById('out');
  function show(line) { out.textContent = line + '\n' + out.textContent; }
  function on(id, fn) { document.getElementById(id).addEventListener('click', fn); }

  // Once the page has loaded. (Where the bridge runs at document start, requests made while the page loads
  // are reported too; where it is injected when the page starts loading, they can be missed.)
  window.addEventListener('load', function () {
    console.info('Page loaded', { path: location.pathname });
    fetch('/json?items=2').then(function (r) { return r.json(); })
      .then(function (d) { show('Page load: ' + d.count + ' items'); });
  });

  on('fetch-ok', function () {
    fetch('/json?items=5', { headers: { 'Accept': 'application/json', 'Authorization': 'Bearer page-token' } })
      .then(function (r) { show('fetch 200 → ' + r.status); return r.text(); });
  });
  on('fetch-404', function () {
    fetch('/missing').then(function (r) { show('fetch 404 → ' + r.status); });
  });
  on('xhr-post', function () {
    var xhr = new XMLHttpRequest();
    xhr.open('POST', '/echo');
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.onload = function () { show('XHR POST → ' + xhr.status + ', ' + xhr.responseText.length + ' characters'); };
    xhr.send(JSON.stringify({ from: 'web view', items: [1, 2, 3] }));
  });
  on('fetch-fail', function () {
    fetch('http://127.0.0.1:1/unreachable').catch(function (e) { show('fetch failing → ' + e.name); });
  });
  on('console', function () {
    console.debug('A debug line from the page');
    console.log('Cart updated', { items: 3, total: 49.9 });
    console.warn('Slow image', { ms: 2300 });
    console.error('Checkout failed', new Error('Card declined'));
    show('console → 4 lines');
  });
  on('throw', function () {
    setTimeout(function () { throw new TypeError('Something broke in the page'); });
    show('Uncaught error → thrown');
  });
</script>
</body>
</html>
"""#
}
