// friday/routes.ts
import express, { Request, Response } from "express";
import { PrismaClient } from "@prisma/client";
import { MAX_PRIMARY_TOKENS_PER_USER } from "./config";

const SUPPLY_ID = "GLOBAL"; // jediný riadok v FridaySupply (globálna pokladnica)

export default function fridayRoutes(prisma: PrismaClient) {
  const router = express.Router();

  async function ensureUser(userId: string) {
    await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });
  }

  // ==============================
  //   SUPPLY (globálne, bez year)
  // ==============================
  router.get("/friday/supply", async (_req: Request, res: Response) => {
    try {
      // riadok v friday_supply držíme pod id="GLOBAL" (vytvára ho admin mint alebo update-price)
      const sup = await prisma.fridaySupply.findUnique({ where: { id: SUPPLY_ID } });

      // dostupné = všetky nepredané aktívne tokeny
      const treasuryCount = await prisma.fridayToken.count({
        where: { ownerId: null, status: "active" },
      });

      return res.json({
        priceEur: Number(sup?.priceEur ?? 0),
        treasuryAvailable: treasuryCount,
        totalMinted: sup?.totalMinted ?? 0,
        totalSold: sup?.totalSold ?? 0,
      });
    } catch (e) {
      console.error("GET /friday/supply", e);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  });

  // ======================================
  //   BALANCE používateľa (bez issuedYear)
  // ======================================
  router.get("/friday/balance/:userId", async (req: Request, res: Response) => {
    try {
      const { userId } = req.params;
      await ensureUser(userId);

      const tokens = await prisma.fridayToken.findMany({
        where: { ownerId: userId },
        orderBy: [{ createdAt: "asc" }],
        select: { id: true, minutesRemaining: true, status: true, originalPriceEur: true, createdAt: true },
      });

      const totalMinutes = tokens
        .filter((t) => t.status === "active")
        .reduce((a, t) => a + t.minutesRemaining, 0);

      return res.json({ userId, totalMinutes, tokens });
    } catch (e) {
      console.error("GET /friday/balance", e);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  });

  // ===========================
  //   NÁKUP (globálne, bez year)
  // ===========================
  router.post("/friday/purchase", async (req: Request, res: Response) => {
    try {
      const { userId, quantity } = req.body || {};
      if (!userId || !Number.isInteger(quantity) || quantity <= 0) {
        return res.status(400).json({ success: false, message: "Missing or invalid userId/quantity" });
      }

      await ensureUser(userId);

      // GLOBÁLNY LIMIT – počet aktívnych tokenov naprieč celým systémom
      const ownedActive = await prisma.fridayToken.count({
        where: { ownerId: userId, status: "active" },
      });
      if (ownedActive + quantity > MAX_PRIMARY_TOKENS_PER_USER) {
        return res.status(400).json({
          success: false,
          message: `Primary limit je ${MAX_PRIMARY_TOKENS_PER_USER} tokenov na osobu.`,
        });
      }

      // Dostupné v pokladnici (nepredané)
      const available = await prisma.fridayToken.findMany({
        where: { ownerId: null, status: "active" },
        take: quantity,
        select: { id: true },
        orderBy: { createdAt: "asc" },
      });
      if (available.length < quantity) {
        return res.status(400).json({ success: false, message: "Not enough tokens in treasury" });
      }

      // Cena z FridaySupply (GLOBAL). Ak neexistuje, 0 (admin ju vie nastaviť/update).
      const sup = await prisma.fridaySupply.findUnique({ where: { id: SUPPLY_ID } });
      const unitPrice = Number(sup?.priceEur ?? 0);
      const amountEur = unitPrice * quantity;

      await prisma.$transaction(async (tx) => {
        // priradenie tokenov kupujúcemu
        await tx.fridayToken.updateMany({
          where: { id: { in: available.map((a) => a.id) } },
          data: { ownerId: userId },
        });

        // záznam do Transaction
        await tx.transaction.create({
          data: {
            userId,
            type: "friday_purchase",
            amountEur,
            secondsDelta: 0,
            note: `friday:global; qty:${quantity}`,
          },
        });

        // inkrement predajov (supply)
        await tx.fridaySupply.upsert({
          where: { id: SUPPLY_ID },
          update: { totalSold: { increment: quantity } },
          create: { id: SUPPLY_ID, totalMinted: 0, totalSold: quantity, priceEur: unitPrice },
        });
      });

      // spätný prehľad
      const tokens = await prisma.fridayToken.findMany({
        where: { ownerId: userId },
        select: { id: true, minutesRemaining: true, status: true, originalPriceEur: true },
        orderBy: [{ createdAt: "asc" }],
      });
      const totalMinutes = tokens
        .filter((t) => t.status === "active")
        .reduce((a, t) => a + t.minutesRemaining, 0);

      return res.json({ success: true, unitPrice, quantity, totalMinutes, tokens });
    } catch (e) {
      console.error("POST /friday/purchase", e);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  });

  // ===========================
  //   SEKUNDÁRNY TRH (bezo zmien)
  // ===========================
  router.post("/friday/list", async (req: Request, res: Response) => {
    try {
      const { sellerId, tokenId, priceEur } = req.body || {};
      if (!sellerId || !tokenId || !priceEur) {
        return res.status(400).json({ success: false, message: "Missing fields" });
      }

      const token = await prisma.fridayToken.findUnique({ where: { id: tokenId } });
      if (!token || token.ownerId !== sellerId) {
        return res.status(400).json({ success: false, message: "Token not owned by seller" });
      }
      if (token.status !== "active" || token.minutesRemaining <= 0) {
        return res.status(400).json({ success: false, message: "Token not listable" });
      }

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
      const listing = await prisma.fridayListing.findUnique({
        where: { id: listingId },
        include: { token: true },
      });
      if (!listing || listing.sellerId !== sellerId || listing.status !== "open") {
        return res.status(400).json({ success: false, message: "Listing not cancellable" });
      }

      await prisma.$transaction(async (tx) => {
        await tx.fridayListing.update({
          where: { id: listingId },
          data: { status: "cancelled", closedAt: new Date() },
        });
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
        take,
        skip,
        include: { token: true },
      });
      return res.json({ items });
    } catch (e) {
      console.error("GET /friday/listings", e);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  });

  // POZOR: starý endpoint /friday/mint-year bol zrušený (ročný systém).
  // Ak ho FE náhodou volá, odstráň volanie na fronte.

  return router;
}
