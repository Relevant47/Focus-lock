export const FOCUS_QUOTES: { text: string; author?: string }[] = [
  { text: "You have power over your mind — not outside events. Realize this, and you will find strength.", author: 'Marcus Aurelius' },
  { text: "He who cannot obey himself will be commanded.", author: 'Friedrich Nietzsche' },
  { text: "The successful warrior is the average man with laser-like focus.", author: 'Bruce Lee' },
  { text: "Discipline is choosing between what you want now and what you want most.", author: 'Abraham Lincoln' },
  { text: "Be so good they can't ignore you.", author: 'Steve Martin' },
  { text: "Deep work is the superpower of the 21st century.", author: 'Cal Newport' },
  { text: "Suffer the pain of discipline or suffer the pain of regret.", author: 'Jim Rohn' },
  { text: "The obstacle is the way.", author: 'Marcus Aurelius' },
  { text: "What we fear doing most is usually what we most need to do.", author: 'Tim Ferriss' },
  { text: "Winning is not a sometime thing — it's an all the time thing.", author: 'Vince Lombardi' },
  { text: "You said you'd finish the chapter first. Honour that promise to yourself." },
  { text: "Every minute you hold is a vote for the person you're becoming." },
  { text: "Small disciplines repeated with consistency every day lead to great achievements.", author: 'John C. Maxwell' },
  { text: "Clarity comes from engagement, not thought.", author: 'Marie Forleo' },
  { text: "Concentration is the secret of strength.", author: 'Ralph Waldo Emerson' },
  { text: "The cost of distraction is paid in the currency of your dreams." },
  { text: "Do the hard thing first. Everything after gets easier." },
  { text: "One hour of focused work beats three of half-attention." },
  { text: "Where focus goes, energy flows.", author: 'Tony Robbins' },
  { text: "Champions keep playing until they get it right.", author: 'Billie Jean King' },
];

export function quoteForDay(date = new Date()): { text: string; author?: string } {
  const day = Math.floor(date.getTime() / 86_400_000);
  return FOCUS_QUOTES[day % FOCUS_QUOTES.length];
}

export function rotatingQuote(intervalMs = 14_000): { text: string; author?: string } {
  const slot = Math.floor(Date.now() / intervalMs);
  return FOCUS_QUOTES[slot % FOCUS_QUOTES.length];
}
