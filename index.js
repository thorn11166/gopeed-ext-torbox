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

  // 0. Quick cache check — if the hash is already in TorBox's global cache
  //    we can skip the long poll delay after createTorrent.
  const hash = extractInfoHash(magnet);
  var alreadyCached = false;
  if (hash) {
    alreadyCached = await checkCached(apiKey, hash);
    if (alreadyCached) {
      gopeed.logger.info('TorBox: hash already cached globally, should be instant');
    }
  }

  // 1. Add magnet to TorBox (or re-use if already there)
  const torrentId = await createTorrent(apiKey, magnet);
  gopeed.logger.info('TorBox: queued, torrentId=' + torrentId);

  // 2. Poll until cached. Skip the initial sleep if we know it's already cached.
  const torrent = await waitUntilCached(apiKey, torrentId, QUICK_POLL_DURATION_MS, alreadyCached);
  const fileCount = (torrent.files || []).length;
  gopeed.logger.info('TorBox: "' + torrent.name + '" ready (' + fileCount + ' file(s))');

  // 3. Build permanent redirect URLs directly — no extra API calls needed.
  //    TorBox's requestdl?redirect=true acts as a permalink: Gopeed follows the
  //    redirect to the CDN link when it actually downloads the file.
  const files = torrent.files || [];
  var resolvedFiles;

  if (files.length <= 1) {
    var fileId = files.length === 1 ? files[0].id : null;
    var url = buildRedirectUrl(apiKey, torrentId, fileId);
    resolvedFiles = [{ name: torrent.name, size: torrent.size || 0, req: { url: url } }];
  } else {
    resolvedFiles = [];
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      var u = buildRedirectUrl(apiKey, torrentId, f.id);
      resolvedFiles.push({ name: f.name, size: f.size || 0, req: { url: u } });
    }
  }

  ctx.res = { name: torrent.name, files: resolvedFiles };
});

// ── Helpers ───────────────────────────────────────────────────

function extractInfoHash(magnet) {
  var match = magnet.match(/[?&]xt=urn:btih:([a-fA-F0-9]{40}|[a-zA-Z2-7]{32})/i);
  return match ? match[1].toLowerCase() : null;
}

async function checkCached(apiKey, hash) {
  try {
    var resp = await fetch(
      API + '/torrents/checkcached?hash=' + hash + '&format=list',
      { headers: { 'Authorization': 'Bearer ' + apiKey } }
    );
    var data = await resp.json();
    if (!data.success) return false;
    // Returns list of cached hashes — non-empty means it's cached
    var d = data.data;
    return Array.isArray(d) ? d.length > 0 : (d && Object.keys(d).length > 0);
  } catch (e) {
    gopeed.logger.warn('TorBox: checkcached error (ignored): ' + e.message);
    return false;
  }
}

// Build a permanent redirect URL — TorBox redirects to the CDN link at download time.
// No API call needed; link stays valid until the token is reset or torrent is deleted.
function buildRedirectUrl(apiKey, torrentId, fileId) {
  var url = API + '/torrents/requestdl' +
    '?token=' + encodeURIComponent(apiKey) +
    '&torrent_id=' + torrentId +
    '&zip_link=false' +
    '&redirect=true';
  if (fileId != null) url += '&file_id=' + fileId;
  return url;
}

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

async function waitUntilCached(apiKey, torrentId, timeoutMs, skipInitialSleep) {
  var deadline = Date.now() + timeoutMs;
  var first = true;
  while (Date.now() < deadline) {
    // Skip the initial delay if the torrent was already globally cached
    if (first && skipInitialSleep) {
      first = false;
    } else {
      first = false;
      await sleep(POLL_INTERVAL_MS);
    }
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

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}
