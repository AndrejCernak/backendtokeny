// src/friday/routes.ts
import express, { Request, Response } from "express";
import { PrismaClient } from "@prisma/client";
import { MAX_PRIMARY_TOKENS_PER_USER } from "./config";

export default function fridayRoutes(prisma: PrismaClient) {
  const router = express.Router();

  async function ensureSettings() {
    const existing = await prisma.fridaySettings.findUnique({ where: { id: 1 } });
    if (!existing) {
      await prisma.fridaySettings.create({ data: { id: 1, currentPriceEur: 0 } });
    }
    return prisma.fridaySettings.findUnique({ where: { id: 1 } });
  }

  async function ensureUser(userId: string) {
    await prisma.user.upsert({
      where: { id: userId },
      update: {},
      create: { id: userId },
    });
  }

  // Mint tokenov (žiadna verifikácia, hocikto zavolá)
  router.post("/friday/admin/mint", async (req: Request, res: Response) => {
    try {
      const { quantity, priceEur } = req.body as {
        quantity?: number | string;
        priceEur?: number | string;
      };
      const qty = Number(quantity);
      const price = Number(priceEur);
      const year = new Date().getFullYear();

      if (!Number.isInteger(qty) || qty <= 0 || !Number.isFinite(price) || price <= 0) {
        return res.status(400).json({ success: false, message: "Invalid quantity/priceEur" });
      }

      await prisma.$transaction(async (tx) => {
        await tx.fridayToken.createMany({
          data: Array.from({ length: qty }, () => ({
            minutesRemaining: 60,
            status: "active",
            originalPriceEur: price,
            issuedYear: year,
          })),
        });

        await tx.fridaySettings.upsert({
          where: { id: 1 },
          update: { currentPriceEur: price },
          create: { id: 1, currentPriceEur: price },
        });
      });

      return res.json({ success: true, minted: qty, priceEur: price, year });
    } catch (e) {
      console.error("POST /friday/admin/mint", e);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  });

  // Nastavenie ceny
  router.post("/friday/admin/set-price", async (req: Request, res: Response) => {
    try {
      const { newPrice, repriceTreasury } = req.body as {
        newPrice?: number | string;
        repriceTreasury?: boolean;
      };
      const price = Number(newPrice);
      if (!Number.isFinite(price) || price <= 0) {
        return res.status(400).json({ success: false, message: "Invalid newPrice" });
      }

      await prisma.$transaction(async (tx) => {
        await tx.fridaySettings.upsert({
          where: { id: 1 },
          update: { currentPriceEur: price },
          create: { id: 1, currentPriceEur: price },
        });

        if (repriceTreasury) {
          await tx.fridayToken.updateMany({
            where: { ownerId: null, status: "active" },
            data: { originalPriceEur: price },
          });
        }
      });

      return res.json({ success: true, priceEur: price });
    } catch (e) {
      console.error("POST /friday/admin/set-price", e);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  });

  // Supply
  router.get("/friday/supply", async (req, res) => {
    try {
      const y = Number((req.query.year as string) || new Date().getFullYear());
      const settings = await ensureSettings();

      const treasuryCount = await prisma.fridayToken.count({
        where: { ownerId: null, status: "active", issuedYear: y },
      });

      return res.json({
        year: y,
        priceEur: Number(settings?.currentPriceEur || 0),
        treasuryAvailable: treasuryCount,
        totalMinted: 0,
        totalSold: 0,
      });
    } catch (e) {
      console.error("GET /friday/supply", e);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  });

  // Balance
  router.get("/friday/balance/:userId", async (req: Request, res: Response) => {
    try {
      const { userId } = req.params;
      const tokens = await prisma.fridayToken.findMany({
        where: { ownerId: userId },
        orderBy: [{ issuedYear: "asc" }, { createdAt: "asc" }],
        select: { id: true, issuedYear: true, minutesRemaining: true, status: true },
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

  // Purchase
  router.post("/friday/purchase", async (req: Request, res: Response) => {
    try {
      const { userId, quantity, year } = (req.body || {}) as {
        userId?: string;
        quantity?: number;
        year?: number | string;
      };

      if (!userId || !Number.isInteger(quantity) || (quantity as number) <= 0) {
        return res
          .status(400)
          .json({ success: false, message: "Missing or invalid userId/quantity" });
      }
      await ensureUser(userId);

      const settings = await ensureSettings();
      const unitPrice = Number(settings?.currentPriceEur || 0);
      if (unitPrice <= 0) {
        return res.status(400).json({ success: false, message: "Treasury price not set" });
      }

      const y = Number(year) || new Date().getFullYear();

      const ownedThisYear = await prisma.fridayToken.count({
        where: { ownerId: userId, issuedYear: y, status: { in: ["active", "listed"] } },
      });
      if (ownedThisYear + (quantity as number) > MAX_PRIMARY_TOKENS_PER_USER) {
        return res.status(400).json({
          success: false,
          message: `Primary limit is ${MAX_PRIMARY_TOKENS_PER_USER} tokens per user for year ${y}`,
        });
      }

      const available = await prisma.fridayToken.findMany({
        where: { ownerId: null, issuedYear: y, status: "active" },
        take: quantity,
        select: { id: true },
      });
      if (available.length < (quantity as number)) {
        return res
          .status(400)
          .json({ success: false, message: "Not enough tokens in treasury" });
      }

      const amountEur = unitPrice * (quantity as number);

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
            note: `friday:${y}; qty:${quantity}; unit:${unitPrice}`,
          },
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

  // Listings
  router.post("/friday/list", async (req: Request, res: Response) => {
    try {
      const { sellerId, tokenId, priceEur } = (req.body || {}) as {
        sellerId?: string;
        tokenId?: string;
        priceEur?: number | string;
      };
      const price = Number(priceEur);

      if (!sellerId || !tokenId || !Number.isFinite(price) || price <= 0) {
        return res
          .status(400)
          .json({ success: false, message: "Missing or invalid fields" });
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
        await tx.fridayListing.create({ data: { tokenId, sellerId, priceEur: price } });
      });

      return res.json({ success: true });
    } catch (e) {
      console.error("POST /friday/list", e);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  });

  router.post("/friday/cancel-listing", async (req: Request, res: Response) => {
    try {
      const { sellerId, listingId } = (req.body || {}) as {
        sellerId?: string;
        listingId?: string;
      };
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
        await tx.fridayToken.update({
          where: { id: listing.tokenId },
          data: { status: "active" },
        });
      });

      return res.json({ success: true });
    } catch (e) {
      console.error("POST /friday/cancel-listing", e);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  });

  router.get("/friday/listings", async (_req: Request, res: Response) => {
    try {
      const items = await prisma.fridayListing.findMany({
        where: { status: "open" },
        orderBy: { createdAt: "desc" },
        take: 50,
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
