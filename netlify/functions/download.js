const REPO = 'Relevant47/Focus-lock';
const GITHUB_RELEASES = `https://github.com/${REPO}/releases/latest`;

exports.handler = async (event) => {
  const params = event.queryStringParameters || {};
  const os = (params.os || '').toLowerCase();
  const arch = (params.arch || 'x64').toLowerCase();

  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

  if (os !== 'win' && os !== 'mac') {
    return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'invalid_os' }) };
  }

  let release;
  try {
    const resp = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github.v3+json' },
    });
    if (resp.status === 404) {
      return { statusCode: 200, headers, body: JSON.stringify({ ok: false, error: 'no_release' }) };
    }
    if (!resp.ok) {
      return { statusCode: 200, headers, body: JSON.stringify({ ok: false, error: 'api_error' }) };
    }
    release = await resp.json();
  } catch {
    return { statusCode: 200, headers, body: JSON.stringify({ ok: false, error: 'api_error' }) };
  }

  const assets = release.assets || [];
  if (assets.length === 0) {
    return { statusCode: 200, headers, body: JSON.stringify({ ok: false, error: 'no_release' }) };
  }

  let asset;
  if (os === 'win') {
    if (arch === 'arm64') {
      asset = assets.find(a => /arm64|aarch64/i.test(a.name) && /\.(exe|msi)$/.test(a.name))
           || assets.find(a => /arm64|aarch64/i.test(a.name));
    } else if (arch === 'x86') {
      asset = assets.find(a => /[_-](x86|i686)[_-]/.test(a.name) && /\.(exe|msi)$/.test(a.name))
           || assets.find(a => /[_-](x86|i686)[_-]/.test(a.name));
    } else {
      // x64 default
      asset = assets.find(a => /[_-]x64[_-]/.test(a.name) && a.name.endsWith('-setup.exe'))
           || assets.find(a => /[_-]x64[_-]/.test(a.name) && /\.(exe|msi)$/.test(a.name))
           || assets.find(a => a.name.endsWith('-setup.exe'))
           || assets.find(a => /\.(exe|msi)$/.test(a.name));
    }
  } else {
    const ua = event.headers['user-agent'] || '';
    const isArm = /arm|aarch64/i.test(ua);
    asset = isArm
      ? (assets.find(a => /aarch64|arm64/i.test(a.name) && a.name.endsWith('.dmg'))
         || assets.find(a => a.name.endsWith('.dmg')))
      : (assets.find(a => /x64/i.test(a.name) && a.name.endsWith('.dmg'))
         || assets.find(a => a.name.endsWith('.dmg')));
  }

  if (!asset) {
    return { statusCode: 200, headers, body: JSON.stringify({ ok: false, error: 'no_asset' }) };
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ ok: true, url: asset.browser_download_url, version: release.tag_name }),
  };
};
