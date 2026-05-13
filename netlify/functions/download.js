const REPO = 'Relevant47/focus-lock';
const FALLBACK = `https://github.com/${REPO}/releases/latest`;

exports.handler = async (event) => {
  const os = (event.queryStringParameters?.os || '').toLowerCase();
  if (os !== 'win' && os !== 'mac') {
    return { statusCode: 302, headers: { Location: FALLBACK } };
  }

  try {
    const resp = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github.v3+json' },
    });

    if (!resp.ok) {
      return { statusCode: 302, headers: { Location: FALLBACK } };
    }

    const release = await resp.json();
    const assets = release.assets || [];

    let asset;
    if (os === 'win') {
      asset = assets.find(a => a.name.endsWith('-setup.exe'))
           || assets.find(a => a.name.endsWith('.exe'))
           || assets.find(a => a.name.endsWith('.msi'));
    } else {
      // Prefer universal/aarch64 DMG for Apple Silicon, fall back to x64
      const ua = event.headers['user-agent'] || '';
      const isArm = /arm|aarch64/i.test(ua);
      asset = isArm
        ? (assets.find(a => a.name.includes('aarch64') && a.name.endsWith('.dmg'))
           || assets.find(a => a.name.endsWith('.dmg')))
        : (assets.find(a => a.name.includes('x64') && a.name.endsWith('.dmg'))
           || assets.find(a => a.name.endsWith('.dmg')));
    }

    const url = asset?.browser_download_url || FALLBACK;
    return { statusCode: 302, headers: { Location: url } };
  } catch {
    return { statusCode: 302, headers: { Location: FALLBACK } };
  }
};
