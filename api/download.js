const REPO = 'Relevant47/focus-lock';
const FALLBACK = `https://github.com/${REPO}/releases/latest`;

export default async function handler(req, res) {
  const os = (req.query.os || '').toLowerCase();
  if (os !== 'win' && os !== 'mac') {
    return res.redirect(302, FALLBACK);
  }

  try {
    const resp = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github.v3+json' },
    });

    if (!resp.ok) return res.redirect(302, FALLBACK);

    const release = await resp.json();
    const assets = release.assets || [];

    let asset;
    if (os === 'win') {
      asset = assets.find(a => a.name.endsWith('-setup.exe'))
           || assets.find(a => a.name.endsWith('.exe'))
           || assets.find(a => a.name.endsWith('.msi'));
    } else {
      const ua = req.headers['user-agent'] || '';
      const isArm = /arm|aarch64/i.test(ua);
      asset = isArm
        ? (assets.find(a => a.name.includes('aarch64') && a.name.endsWith('.dmg'))
           || assets.find(a => a.name.endsWith('.dmg')))
        : (assets.find(a => a.name.includes('x64') && a.name.endsWith('.dmg'))
           || assets.find(a => a.name.endsWith('.dmg')));
    }

    return res.redirect(302, asset?.browser_download_url || FALLBACK);
  } catch {
    return res.redirect(302, FALLBACK);
  }
}
