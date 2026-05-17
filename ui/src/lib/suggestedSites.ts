export interface SuggestedSite {
  domain: string;
  label: string;
  category: 'Social' | 'Entertainment' | 'Gaming' | 'News';
}

export const SUGGESTED_SITES: SuggestedSite[] = [
  { domain: 'youtube.com',   label: 'YouTube',         category: 'Entertainment' },
  { domain: 'netflix.com',   label: 'Netflix',         category: 'Entertainment' },
  { domain: 'twitch.tv',     label: 'Twitch',          category: 'Entertainment' },
  { domain: 'reddit.com',    label: 'Reddit',          category: 'Social' },
  { domain: 'twitter.com',   label: 'Twitter / X',     category: 'Social' },
  { domain: 'x.com',         label: 'X',               category: 'Social' },
  { domain: 'instagram.com', label: 'Instagram',       category: 'Social' },
  { domain: 'tiktok.com',    label: 'TikTok',          category: 'Social' },
  { domain: 'facebook.com',  label: 'Facebook',        category: 'Social' },
  { domain: 'linkedin.com',  label: 'LinkedIn feed',   category: 'Social' },
  { domain: '9gag.com',      label: '9GAG',            category: 'Entertainment' },
  { domain: 'discord.com',   label: 'Discord',         category: 'Social' },
  { domain: 'steam.com',     label: 'Steam',           category: 'Gaming' },
  { domain: 'epicgames.com', label: 'Epic Games',      category: 'Gaming' },
  { domain: 'news.ycombinator.com', label: 'Hacker News', category: 'News' },
  { domain: 'cnn.com',       label: 'CNN',             category: 'News' },
  { domain: 'bbc.com',       label: 'BBC',             category: 'News' },
  { domain: 'nytimes.com',   label: 'NYT',             category: 'News' },
];

export function faviconUrl(domain: string, size = 32): string {
  return `https://www.google.com/s2/favicons?domain=${domain}&sz=${size}`;
}
