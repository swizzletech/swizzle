// Times and durations in words. Each takes `now` where the words depend on the clock, so tests pin it.

/** When a queued run fails if no worker takes it: "18:00, in 3 h", or "Fri 18:00, in 30 h". */
export function deadlineInWords(iso: string, now: Date): string {
  const deadline = new Date(iso);
  const at =
    deadline.toDateString() === now.toDateString()
      ? clockTime(deadline)
      : `${deadline.toLocaleDateString("en-GB", { weekday: "short" })} ${clockTime(deadline)}`;
  return `${at}, in ${durationInWords(Math.max(0, deadline.getTime() - now.getTime()))}`;
}

export function clockTime(date: Date): string {
  return date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

/** "0.4 s", "18 s", "3 min", "2 h 5 min", "12 days". */
export function durationInWords(ms: number): string {
  if (ms >= 48 * 60 * 60_000) return `${Math.round(ms / (24 * 60 * 60_000))} days`;
  if (ms < 10_000) return `${(ms / 1_000).toFixed(1)} s`;
  if (ms < 60_000) return `${Math.round(ms / 1_000)} s`;
  if (ms < 60 * 60_000) return `${Math.round(ms / 60_000)} min`;
  const totalMinutes = Math.round(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours} h` : `${hours} h ${minutes} min`;
}

/** "does not expire", "expired" or "expires in 29 days". */
export function expiryInWords(expiresAt: string | null, now: Date): string {
  if (expiresAt === null) return "does not expire";
  const left = Date.parse(expiresAt) - now.getTime();
  return left < 0 ? "expired" : `expires in ${durationInWords(left)}`;
}

/** "just now", "4 min ago", "2 h ago", "3 days ago". */
export function ageInWords(iso: string, now: Date): string {
  const ms = now.getTime() - Date.parse(iso);
  if (ms < 45_000) return "just now";
  if (ms < 60 * 60_000) return `${Math.max(1, Math.round(ms / 60_000))} min ago`;
  if (ms < 24 * 60 * 60_000) return `${Math.round(ms / (60 * 60_000))} h ago`;
  const days = Math.round(ms / (24 * 60 * 60_000));
  return days === 1 ? "yesterday" : `${days} days ago`;
}
