// friday/routes.ts
import express, { Request, Response } from "express";
import { PrismaClient } from "@prisma/client";
import { MAX_PRIMARY_TOKENS_PER_USER, priceForYear, countFridaysInYear } from "./config";

const SUPPLY_KEY = 1; // globálna pokladnica


export default function fridayRoutes(prisma: PrismaClient) {
  const router = express.Router();

  async function ensureUser(userId: string) {
    await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });
  }

  router.post("/friday/mint-year", async (req: Request, res: Response) => {
    try {
      const { year } = req.body || {};
      const y = Number(year) || new Date().getFullYear();
      const exists = await prisma.fridaySupply.findUnique({ where: { year: y } });
      if (exists) return res.status(400).json({ success: false, message: "Supply already minted for this year" });

      const fridays = countFridaysInYear(y);
      const totalTokens = fridays * 6;
      const unitPrice = priceForYear(y);

      await prisma.$transaction(async (tx) => {
        await tx.fridaySupply.create({ data: { year: y, totalMinted: totalTokens, priceEur: unitPrice } });
        const batch = Array.from({ length: totalTokens }, () => ({
          issuedYear: y, ownerId: null, minutesRemaining: 60, status: "active" as const, originalPriceEur: unitPrice
        }));
        const CHUNK = 1000;
        for (let i = 0; i < batch.length; i += CHUNK) {
          await tx.fridayToken.createMany({ data: batch.slice(i, i + CHUNK) });
        }
      });

      return res.json({ success: true, year: y, tokensMinted: totalTokens, unitPrice });
    } catch (e) {
      console.error("POST /friday/mint-year", e);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  });

 router.get("/friday/supply", async (req, res) => {
  try {
    // Ak nepríde year, ideme globálne (SUPPLY_KEY = 1)
    const yParam = req.query.year as string | undefined;
    const y = yParam ? Number(yParam) : SUPPLY_KEY;

    const sup = await prisma.fridaySupply.findUnique({ where: { year: y } });

    // dostupné = všetky nepredané aktívne tokeny pre daný "rok" (v globále je to 1)
    const treasuryCount = await prisma.fridayToken.count({
      where: { ownerId: null, issuedYear: y, status: "active" },
    });

    return res.json({
      year: y,
      priceEur: sup?.priceEur ?? 0,
      treasuryAvailable: treasuryCount,
      totalMinted: sup?.totalMinted ?? 0,
      totalSold: sup?.totalSold ?? 0,
    });
  } catch (e) {
    console.error("GET /friday/supply", e);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});



  router.get("/friday/balance/:userId", async (req: Request, res: Response) => {
    try {
      const { userId } = req.params;
      const tokens = await prisma.fridayToken.findMany({
        where: { ownerId: userId },
        orderBy: [{ issuedYear: "asc" }, { createdAt: "asc" }],
        select: { id: true, issuedYear: true, minutesRemaining: true, status: true },
      });
      const totalMinutes = tokens.filter(t => t.status === "active").reduce((a, t) => a + t.minutesRemaining, 0);
      return res.json({ userId, totalMinutes, tokens });
    } catch (e) {
      console.error("GET /friday/balance", e);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  });

  router.post("/friday/purchase", async (req: Request, res: Response) => {
  try {
    const { userId, quantity, year } = req.body || {};
    if (!userId || !Number.isInteger(quantity) || quantity <= 0) {
      return res.status(400).json({ success: false, message: "Missing or invalid userId/quantity" });
    }

    // Globálny režim defaultom
    const y = year ? Number(year) : SUPPLY_KEY;

    // GLOBÁLNY LIMIT (počet aktívnych tokenov naprieč všetkými „rokmi“)
    const ownedActive = await prisma.fridayToken.count({
      where: { ownerId: userId, status: "active" },
    });
    if (ownedActive + quantity > MAX_PRIMARY_TOKENS_PER_USER) {
      return res.status(400).json({
        success: false,
        message: `Primary limit je ${MAX_PRIMARY_TOKENS_PER_USER} tokenov na osobu.`,
      });
    }

    // Dostupné v pokladnici (nepredané pre daný y)
    const available = await prisma.fridayToken.findMany({
      where: { ownerId: null, issuedYear: y, status: "active" },
      take: quantity,
      select: { id: true },
      orderBy: { id: "asc" },
    });
    if (available.length < quantity) {
      return res.status(400).json({ success: false, message: "Not enough tokens in treasury" });
    }

    // Cena berieme z fridaySupply(y). Ak chýba, 0 (admin ju vie nastaviť / meniť).
    const sup = await prisma.fridaySupply.findUnique({ where: { year: y } });
    const unitPrice = Number(sup?.priceEur ?? 0);
    const amountEur = unitPrice * quantity;

    await prisma.$transaction(async (tx) => {
      await tx.fridayToken.updateMany({
        where: { id: { in: available.map((a) => a.id) } },
        data: { ownerId: userId },
      });
      await tx.transaction.create({
        data: {
          userId,
          type: "friday_purchase",
          amountEur,
          secondsDelta: 0,
          note: `friday:${y}; qty:${quantity}`,
        },
      });
      // supply riadok existuje už po admin mint/update-price; ak by neexistoval, založíme s nulami
      await tx.fridaySupply.upsert({
        where: { year: y },
        update: { totalSold: { increment: quantity } },
        create: { year: y, totalMinted: 0, totalSold: quantity, priceEur: unitPrice },
      });
    });

    const tokens = await prisma.fridayToken.findMany({
      where: { ownerId: userId },
      select: { id: true, issuedYear: true, minutesRemaining: true, status: true },
      orderBy: [{ issuedYear: "asc" }, { createdAt: "asc" }],
    });
    const totalMinutes = tokens
      .filter((t) => t.status === "active")
      .reduce((a, t) => a + t.minutesRemaining, 0);

    return res.json({ success: true, year: y, unitPrice, quantity, totalMinutes, tokens });
  } catch (e) {
    console.error("POST /friday/purchase", e);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});


  router.post("/friday/list", async (req: Request, res: Response) => {
    try {
      const { sellerId, tokenId, priceEur } = req.body || {};
      if (!sellerId || !tokenId || !priceEur) return res.status(400).json({ success: false, message: "Missing fields" });
      const token = await prisma.fridayToken.findUnique({ where: { id: tokenId } });
      if (!token || token.ownerId !== sellerId) return res.status(400).json({ success: false, message: "Token not owned by seller" });
      if (token.status !== "active" || token.minutesRemaining <= 0) return res.status(400).json({ success: false, message: "Token not listable" });

      await prisma.$transaction(async (tx) => {
        await tx.fridayToken.update({ where: { id: tokenId }, data: { status: "listed" } });
        await tx.fridayListing.create({ data: { tokenId, sellerId, priceEur: Number(priceEur) } });
      });
      return res.json({ success: true });
    } catch (e) {
      console.error("POST /friday/list", e);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  });

  router.post("/friday/cancel-listing", async (req: Request, res: Response) => {
    try {
      const { sellerId, listingId } = req.body || {};
      const listing = await prisma.fridayListing.findUnique({ where: { id: listingId }, include: { token: true } });
      if (!listing || listing.sellerId !== sellerId || listing.status !== "open") {
        return res.status(400).json({ success: false, message: "Listing not cancellable" });
      }
      await prisma.$transaction(async (tx) => {
        await tx.fridayListing.update({ where: { id: listingId }, data: { status: "cancelled", closedAt: new Date() } });
        await tx.fridayToken.update({ where: { id: listing.tokenId }, data: { status: "active" } });
      });
      return res.json({ success: true });
    } catch (e) {
      console.error("POST /friday/cancel-listing", e);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  });

  router.get("/friday/listings", async (_req: Request, res: Response) => {
    try {
      const take = 50;
      const skip = 0;
      const items = await prisma.fridayListing.findMany({
        where: { status: "open" },
        orderBy: { createdAt: "desc" },
        take, skip,
        include: { token: true },
      });
      return res.json({ items });
    } catch (e) {
      console.error("GET /friday/listings", e);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  });

  return router;
}
