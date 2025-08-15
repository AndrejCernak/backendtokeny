"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.fridayMinutes = fridayMinutes;
exports.consumeFridaySeconds = consumeFridaySeconds;
// friday/db.ts
const client_1 = require("@prisma/client");
const prisma = new client_1.PrismaClient();
async function fridayMinutes(userId) {
    const tokens = await prisma.fridayToken.findMany({
        where: { ownerId: userId, status: "active", minutesRemaining: { gt: 0 } },
        select: { minutesRemaining: true },
    });
    return tokens.reduce((a, t) => a + t.minutesRemaining, 0);
}
async function consumeFridaySeconds(userId, seconds) {
    const tokens = await prisma.fridayToken.findMany({
        where: { ownerId: userId, status: "active", minutesRemaining: { gt: 0 } },
        orderBy: { createdAt: "asc" }, // odstránený issuedYear
    });
    let restSec = seconds;
    for (const t of tokens) {
        if (restSec <= 0)
            break;
        const tokenSec = t.minutesRemaining * 60;
        const usedSec = Math.min(tokenSec, restSec);
        const leftSec = tokenSec - usedSec;
        const leftMin = Math.ceil(leftSec / 60);
        await prisma.fridayToken.update({
            where: { id: t.id },
            data: { minutesRemaining: leftMin, status: leftMin <= 0 ? "spent" : "active" },
        });
        restSec -= usedSec;
    }
    return restSec; // deficit ak > 0
}
