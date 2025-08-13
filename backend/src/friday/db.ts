// friday/db.ts
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

export async function fridayMinutes(userId: string) {
  const tokens = await prisma.fridayToken.findMany({
    where: { ownerId: userId, status: "active", minutesRemaining: { gt: 0 } },
    select: { minutesRemaining: true },
  });
  return tokens.reduce((a, t) => a + t.minutesRemaining, 0);
}

export async function consumeFridaySeconds(userId: string, seconds: number) {
  const tokens = await prisma.fridayToken.findMany({
    where: { ownerId: userId, status: "active", minutesRemaining: { gt: 0 } },
    orderBy: [{ issuedYear: "asc" }, { createdAt: "asc" }],
  });

  let restSec = seconds;
  for (const t of tokens) {
    if (restSec <= 0) break;
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
