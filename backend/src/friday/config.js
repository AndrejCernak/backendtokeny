// Konfigurácia/cenový model pre piatkové tokeny
const FRIDAY_BASE_YEAR = Number(process.env.FRIDAY_BASE_YEAR || 2025);
const FRIDAY_BASE_PRICE_EUR = Number(process.env.FRIDAY_BASE_PRICE_EUR || 450);
const MAX_PRIMARY_TOKENS_PER_USER = Number(process.env.MAX_PRIMARY_TOKENS_PER_USER || 20);

function priceForYear(year) {
  const diff = year - FRIDAY_BASE_YEAR;
  const price = FRIDAY_BASE_PRICE_EUR * Math.pow(1.1, diff);
  return Math.round(price * 100) / 100;
}

function isFridayInBratislava(now = new Date()) {
  const local = new Date(now.toLocaleString("en-US", { timeZone: "Europe/Bratislava" }));
  return local.getDay() === 5;
}

function countFridaysInYear(year) {
  let count = 0;
  const d = new Date(Date.UTC(year, 0, 1));
  while (d.getUTCFullYear() === year) {
    const local = new Date(d.toLocaleString("en-US", { timeZone: "Europe/Bratislava" }));
    if (local.getDay() === 5) count++;
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return count;
}

module.exports = {
  FRIDAY_BASE_YEAR,
  FRIDAY_BASE_PRICE_EUR,
  MAX_PRIMARY_TOKENS_PER_USER,
  priceForYear,
  isFridayInBratislava,
  countFridaysInYear,
};
