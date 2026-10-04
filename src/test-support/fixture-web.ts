/**
 * Loopback fixture "SPA": a static shell that renders event cards via JS,
 * plus a cookie banner, a load-more button, a native select filter, a lazy
 * scroll section, post-render JSON-LD, and a redirect fixture — everything
 * the runner integration tests need, with zero external network.
 */

import { createServer, type Server } from "node:http";

const CARDS = Array.from({ length: 14 }, (_, i) => ({
  title: `Fixture Event ${i + 1}`,
  url: `/detail/event-${i + 1}`,
  date: `2026-11-${String(i + 1).padStart(2, "0")}`,
}));

export interface FixtureWeb {
  origin: string;
  stop: () => Promise<void>;
}

export async function startFixtureWeb(): Promise<FixtureWeb> {
  const server: Server = createServer((request, response) => {
    const url = request.url ?? "/";

    if (url === "/api/events") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ events: [{ id: 1, title: "API Event One" }, { id: 2, title: "API Event Two" }] }));

      return;
    }

    if (url === "/redirect") {
      response.writeHead(302, { location: "/" });
      response.end();

      return;
    }

    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!DOCTYPE html>
<html><head><title>Fixture SPA</title></head>
<body>
<div id="cookie-banner" style="display:block"><button id="cookie-accept">Accept cookies</button></div>
<select id="filter"><option value="all">All</option><option value="music">Music</option></select>
<button id="load-more" onclick="window.renderMore()">Load more</button>
<main id="content"></main>
<a href="/redirect" id="redirect-link">redirect</a>
<a href="/detail/event-1" target="_blank" id="popup-link">popup</a>
<script type="application/ld+json">{"@type":"Event","name":"Pre-render Event","startDate":"2026-10-30"}</script>
<script>
  var shown = 0;
  function renderBatch() {
    var main = document.getElementById('content');
    for (var i = 0; i < 6 && shown < ${CARDS.length}; i++, shown++) {
      var card = document.createElement('article');
      card.className = 'event';
      card.innerHTML = '<h3>Fixture Event ' + (shown + 1) + '</h3>' +
        '<a href="/detail/event-' + (shown + 1) + '">detail</a>' +
        '<time datetime="2026-11-' + String(shown + 1).padStart(2, '0') + '">Nov ' + (shown + 1) + '</time>';
      main.appendChild(card);
    }
    if (shown >= 6) {
      var ld = document.createElement('script');
      ld.type = 'application/ld+json';
      ld.textContent = JSON.stringify({"@type":"Event","name":"Rendered Event","startDate":"2026-12-01"});
      document.head.appendChild(ld);
    }
  }
  window.renderMore = function () {
    renderBatch();
    fetch('/api/events').then(function (r) { return r.json(); });
  };
  document.getElementById('cookie-accept').onclick = function () {
    document.getElementById('cookie-banner').style.display = 'none';
  };
  document.getElementById('filter').onchange = function () { renderBatch(); };
  setTimeout(renderBatch, 150);
</script>
</body></html>`);
  });

  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));

  const address = server.address();

  // SAFETY: TCP listen addresses carry a numeric port; the assertion is
  // guarded by the explicit null/string rejection above it.
  // SAFETY: TCP listen addresses carry a numeric port; anything else is rejected.
  // SAFETY: AddressInfo is the TCP variant of listen addresses.
  const isTcpAddress = (value: ReturnType<Server["address"]>): value is import("node:net").AddressInfo =>
    value !== null && typeof value !== "string";

  if (!isTcpAddress(address)) {
    throw new Error("no port");
  }

  return {
    origin: `http://127.0.0.1:${address.port}`,
    stop: () => new Promise<void>((resolveStop) => server.close(() => resolveStop())),
  };
}
