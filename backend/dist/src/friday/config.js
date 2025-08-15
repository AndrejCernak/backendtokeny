"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_PRIMARY_TOKENS_PER_USER = exports.FRIDAY_BASE_PRICE_EUR = exports.FRIDAY_BASE_YEAR = void 0;
exports.priceForYear = priceForYear;
exports.isFridayInBratislava = isFridayInBratislava;
exports.countFridaysInYear = countFridaysInYear;
// friday/config.ts
exports.FRIDAY_BASE_YEAR = Number(process.env.FRIDAY_BASE_YEAR || 2025);
exports.FRIDAY_BASE_PRICE_EUR = Number(process.env.FRIDAY_BASE_PRICE_EUR || 450);
exports.MAX_PRIMARY_TOKENS_PER_USER = Number(process.env.MAX_PRIMARY_TOKENS_PER_USER || 20);
function priceForYear(year) {
    const diff = year - exports.FRIDAY_BASE_YEAR;
    const price = exports.FRIDAY_BASE_PRICE_EUR * Math.pow(1.1, diff);
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
        if (local.getDay() === 5)
            count++;
        d.setUTCDate(d.getUTCDate() + 1);
    }
    return count;
}
