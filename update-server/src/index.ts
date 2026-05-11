/**
 * FocusLock Update Server — Cloudflare Worker
 *
 * Deploy:
 *   cd update-server
 *   npm install
 *   npx wrangler deploy
 *
 * Set your GitHub repo in wrangler.toml, then configure tauri.conf.json:
 *   "endpoints": ["https://focuslock-updates.YOUR_SUBDOMAIN.workers.dev/{{target}}/{{arch}}/{{current_version}}"]
 *
 * URL pattern: /{target}/{arch}/{current_version}
 * e.g. /windows/x86_64/1.0.0  or  /darwin/aarch64/1.0.0
 */

interface Env {
  GITHUB_OWNER: string;
  GITHUB_REPO: string;
}

interface GitHubRelease {
  tag_name: string;
  name: string;
  body: string;
  published_at: string;
  assets: GitHubAsset[];
}

interface GitHubAsset {
  name: string;
  browser_download_url: string;
}

interface TauriPlatformUpdate {
  signature: string;
  url: string;
}

interface TauriUpdateManifest {
  version: string;
  notes: string;
  pub_date: string;
  platforms: Record<string, TauriPlatformUpdate>;
}

// Maps Tauri target strings to GitHub asset filename fragments
const ASSET_MAP: Record<string, string[]> = {
  'windows-x86_64': ['x64-setup.exe', 'x86_64-setup.exe', 'windows-x86_64'],
  'darwin-aarch64': ['aarch64.dmg', 'darwin-aarch64', 'arm64.dmg'],
  'darwin-x86_64':  ['x86_64.dmg',  'darwin-x86_64',  'x64.dmg'],
};

function semverGt(a: string, b: string): boolean {
  const parse = (v: string) => v.replace(/^v/, '').split('.').map(Number);
  const [aMaj, aMin, aPat] = parse(a);
  const [bMaj, bMin, bPat] = parse(b);
  if (aMaj !== bMaj) return aMaj > bMaj;
  if (aMin !== bMin) return aMin > bMin;
  return aPat > bPat;
}

function findAsset(assets: GitHubAsset[], platformKey: string): GitHubAsset | null {
  const fragments = ASSET_MAP[platformKey] ?? [platformKey];
  return assets.find(a => fragments.some(f => a.name.toLowerCase().includes(f.toLowerCase()))) ?? null;
}

function findSig(assets: GitHubAsset[], assetName: string): string {
  const sigAsset = assets.find(a => a.name === `${assetName}.sig`);
  return sigAsset?.browser_download_url ?? '';
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url    = new URL(request.url);
    const parts  = url.pathname.split('/').filter(Boolean);

    if (parts.length < 3) {
      return new Response('Usage: /{target}/{arch}/{current_version}', { status: 400 });
    }

    const [target, arch, currentVersion] = parts;
    const platformKey = `${target}-${arch}`;

    // Fetch latest release from GitHub
    const ghUrl = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/releases/latest`;
    const ghRes  = await fetch(ghUrl, {
      headers: {
        'User-Agent': 'FocusLock-UpdateServer/1.0',
        'Accept': 'application/vnd.github.v3+json',
      },
    });

    if (!ghRes.ok) {
      return new Response('Failed to fetch release info', { status: 502 });
    }

    const release = await ghRes.json() as GitHubRelease;
    const latestVersion = release.tag_name.replace(/^v/, '');

    // No update needed
    if (!semverGt(latestVersion, currentVersion)) {
      return new Response(null, { status: 204 });
    }

    // Find the right asset for this platform
    const asset = findAsset(release.assets, platformKey);
    if (!asset) {
      return new Response(null, { status: 204 }); // no asset for this platform yet
    }

    // Fetch the signature file content (Tauri requires the actual signature string, not a URL)
    const sigUrl  = `${asset.browser_download_url}.sig`;
    const sigRes  = await fetch(sigUrl, { headers: { 'User-Agent': 'FocusLock-UpdateServer/1.0' } });
    const sigText = sigRes.ok ? await sigRes.text() : '';

    const manifest: TauriUpdateManifest = {
      version:  latestVersion,
      notes:    release.body ?? '',
      pub_date: release.published_at,
      platforms: {
        [platformKey]: {
          signature: sigText.trim(),
          url: asset.browser_download_url,
        },
      },
    };

    return Response.json(manifest, {
      headers: {
        'Cache-Control': 'max-age=300', // 5-minute cache
        'Access-Control-Allow-Origin': '*',
      },
    });
  },
} satisfies ExportedHandler<Env>;
