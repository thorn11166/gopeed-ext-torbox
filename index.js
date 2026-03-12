const API = 'https://api.torbox.app/v1/api';

// How long to wait for TorBox to cache before giving up and telling the user to retry.
// TorBox often caches popular torrents within seconds; for others it may take longer.
const QUICK_POLL_DURATION_MS = 90 * 1000; // 90 seconds
const POLL_INTERVAL_MS = 5000;

gopeed.events.onResolve(async function (ctx) {
  const apiKey = gopeed.settings.apiKey;
  if (!apiKey) {
    throw new Error('TorBox: API key not set — open Extensions → TorBox Debrid → Settings and enter your key from torbox.app');
  }

  const magnet = ctx.req.url;
  gopeed.logger.info('TorBox: submitting magnet…');

  // 1. Add magnet to TorBox (or re-use if already there)
  const torrentId = await createTorrent(apiKey, magnet);
  gopeed.logger.info('TorBox: queued, torrentId=' + torrentId);

  // 2. Poll for up to 90 s — enough for cached/popular torrents to resolve immediately.
  //    If not ready in time, throw a friendly error so the user can paste it again later.
  const torrent = await waitUntilCached(apiKey, torrentId, QUICK_POLL_DURATION_MS);
  const fileCount = (torrent.files || []).length;
  gopeed.logger.info('TorBox: "' + torrent.name + '" ready (' + fileCount + ' file(s))');

  // 3. Fetch download links and hand them back to Gopeed
  const files = torrent.files || [];
  var resolvedFiles;

  if (files.length <= 1) {
    var fileId = files.length === 1 ? files[0].id : null;
    var url = await requestDL(apiKey, torrentId, fileId);
    resolvedFiles = [{ name: torrent.name, size: torrent.size || 0, req: { url: url } }];
  } else {
    resolvedFiles = [];
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      var u = await requestDL(apiKey, torrentId, f.id);
      resolvedFiles.push({ name: f.name, size: f.size || 0, req: { url: u } });
    }
  }

  ctx.res = { name: torrent.name, files: resolvedFiles };
});

// ── Helpers ───────────────────────────────────────────────────

async function createTorrent(apiKey, magnet) {
  var fd = new FormData();
  fd.append('magnet', magnet);
  fd.append('seed', '1');

  var resp = await fetch(API + '/torrents/createtorrent', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + apiKey },
    body: fd,
  });
  var data = await resp.json();
  if (!data.success) {
    throw new Error('TorBox add failed: ' + (data.detail || data.error || JSON.stringify(data)));
  }
  var id = (data.data && (data.data.torrent_id || data.data.id));
  if (!id) {
    throw new Error('TorBox: no torrent ID in response: ' + JSON.stringify(data));
  }
  return id;
}

async function waitUntilCached(apiKey, torrentId, timeoutMs) {
  var deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    try {
      var resp = await fetch(
        API + '/torrents/mylist?id=' + torrentId + '&bypass_cache=true',
        { headers: { 'Authorization': 'Bearer ' + apiKey } }
      );
      var data = await resp.json();
      var torrent = Array.isArray(data.data) ? data.data[0] : data.data;
      if (!torrent) continue;

      var pct = Math.round((torrent.progress || 0) * 100);
      gopeed.logger.debug('TorBox: ' + pct + '% state=' + (torrent.download_state || torrent.status || '?'));

      if (torrent.cached || torrent.download_state === 'cached' || (torrent.progress || 0) >= 1.0) {
        return torrent;
      }
    } catch (e) {
      gopeed.logger.warn('TorBox: poll error (retrying): ' + e.message);
    }
  }
  throw new Error(
    'TorBox is still caching this torrent. Paste the magnet again in ~1 minute to check if it\'s ready.'
  );
}

async function requestDL(apiKey, torrentId, fileId) {
  var query = 'token=' + encodeURIComponent(apiKey) +
    '&torrent_id=' + torrentId +
    '&zip_link=false';
  if (fileId != null) query += '&file_id=' + fileId;

  var resp = await fetch(API + '/torrents/requestdl?' + query, {
    headers: { 'Authorization': 'Bearer ' + apiKey },
  });
  var data = await resp.json();
  if (!data.success) {
    throw new Error('TorBox requestdl failed: ' + (data.detail || data.error || JSON.stringify(data)));
  }
  return data.data;
}

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}
