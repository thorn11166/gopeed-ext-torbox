const API = 'https://api.torbox.app/v1/api';

gopeed.events.onResolve(async function (ctx) {
  const apiKey = gopeed.settings.apiKey;
  if (!apiKey) {
    throw new Error('TorBox: API key not set — open Extensions in Gopeed settings and enter your key from torbox.app');
  }

  const magnet = ctx.req.url;
  gopeed.logger.info('TorBox: submitting magnet…');

  // 1. Add magnet to TorBox
  const torrentId = await createTorrent(apiKey, magnet);
  gopeed.logger.info('TorBox: queued, torrentId=' + torrentId);

  // 2. Poll until TorBox has fully cached it
  const torrent = await waitUntilCached(apiKey, torrentId);
  const fileCount = (torrent.files || []).length;
  gopeed.logger.info('TorBox: "' + torrent.name + '" ready (' + fileCount + ' file(s))');

  // 3. Fetch download links and hand them back to Gopeed
  const files = torrent.files || [];
  let resolvedFiles;

  if (files.length <= 1) {
    const fileId = files.length === 1 ? files[0].id : null;
    const url = await requestDL(apiKey, torrentId, fileId);
    resolvedFiles = [{ name: torrent.name, size: torrent.size || 0, req: { url: url } }];
  } else {
    resolvedFiles = [];
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      var url = await requestDL(apiKey, torrentId, f.id);
      resolvedFiles.push({ name: f.name, size: f.size || 0, req: { url: url } });
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

async function waitUntilCached(apiKey, torrentId) {
  var deadline = Date.now() + 6 * 60 * 60 * 1000; // 6 hours max
  while (Date.now() < deadline) {
    await sleep(5000);
    try {
      var resp = await fetch(
        API + '/torrents/mylist?id=' + torrentId + '&bypass_cache=true',
        { headers: { 'Authorization': 'Bearer ' + apiKey } }
      );
      var data = await resp.json();
      var torrent = Array.isArray(data.data) ? data.data[0] : data.data;
      if (!torrent) continue;

      var pct = Math.round((torrent.progress || 0) * 100);
      gopeed.logger.debug('TorBox: caching ' + pct + '% state=' + (torrent.download_state || torrent.status || '?'));

      if (torrent.cached || torrent.download_state === 'cached' || (torrent.progress || 0) >= 1.0) {
        return torrent;
      }
    } catch (e) {
      gopeed.logger.warn('TorBox: poll error (retrying): ' + e.message);
    }
  }
  throw new Error('TorBox: timed out (6 h) waiting for torrent to be cached');
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
