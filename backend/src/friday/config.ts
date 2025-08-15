// friday/config.ts
export const FRIDAY_BASE_YEAR = Number(process.env.FRIDAY_BASE_YEAR || 2025);
export const FRIDAY_BASE_PRICE_EUR = Number(process.env.FRIDAY_BASE_PRICE_EUR || 450);
export const MAX_PRIMARY_TOKENS_PER_USER = Number(process.env.MAX_PRIMARY_TOKENS_PER_USER || 20);

export function priceForYear(year: number) {
  const diff = year - FRIDAY_BASE_YEAR;
  const price = FRIDAY_BASE_PRICE_EUR * Math.pow(1.1, diff);
  return Math.round(price * 100) / 100;
}

export function isFridayInBratislava(now = new Date()) {
  const local = new Date(now.toLocaleString("en-US", { timeZone: "Europe/Bratislava" }));
  return local.getDay() === 5;
}

export function countFridaysInYear(year: number) {
  let count = 0;
  const d = new Date(Date.UTC(year, 0, 1));
  while (d.getUTCFullYear() === year) {
    const local = new Date(d.toLocaleString("en-US", { timeZone: "Europe/Bratislava" }));
    if (local.getDay() === 5) count++;
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return count;
}