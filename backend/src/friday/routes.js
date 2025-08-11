const express = require("express");
const {
  MAX_PRIMARY_TOKENS_PER_USER,
  priceForYear,
  countFridaysInYear,
} = require("./config");

module.exports = function fridayRoutes(prisma) {
  const router = express.Router();

  // Admin: emisia pre rok (mint do treasury = ownerId:null)
  router.post("/friday/mint-year", async (req, res) => {
    try {
      const { year } = req.body || {};
      const y = Number(year) || new Date().getFullYear();
      const exists = await prisma.fridaySupply.findUnique({ where: { year: y } });
      if (exists) return res.status(400).json({ success: false, message: "Supply already minted for this year" });

      const fridays = countFridaysInYear(y);
      const totalTokens = fridays * 6; // 6 hodín = 6 tokenov na piatok
      const unitPrice = priceForYear(y);

      await prisma.$transaction(async (tx) => {
        await tx.fridaySupply.create({
          data: { year: y, totalMinted: totalTokens, priceEur: unitPrice },
        });

        const batch = Array.from({ length: totalTokens }, () => ({
          issuedYear: y,
          ownerId: null,
          minutesRemaining: 60,
          status: "active",
          originalPriceEur: unitPrice,
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

  // Info o supply/cene pre rok
  router.get("/friday/supply", async (req, res) => {
    try {
      const y = Number(req.query.year) || new Date().getFullYear();
      let sup = await prisma.fridaySupply.findUnique({ where: { year: y } });
      if (!sup) {
        sup = {
          year: y,
          totalMinted: 0,
          totalSold: 0,
          priceEur: priceForYear(y),
          createdAt: new Date(),
        };
      }
      const treasuryCount = await prisma.fridayToken.count({ where: { ownerId: null, issuedYear: y, status: "active" } });
      return res.json({
        year: y,
        priceEur: Number(sup.priceEur),
        treasuryAvailable: treasuryCount,
        totalMinted: sup.totalMinted,
        totalSold: sup.totalSold,
      });
    } catch (e) {
      console.error("GET /friday/supply", e);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  });

  // Piatkový zostatok
  router.get("/friday/balance/:userId", async (req, res) => {
    try {
      const { userId } = req.params;
      const tokens = await prisma.fridayToken.findMany({
        where: { ownerId: userId },
        orderBy: [{ issuedYear: "asc" }, { createdAt: "asc" }],
        select: { id: true, issuedYear: true, minutesRemaining: true, status: true },
      });
      const totalMinutes = tokens.filter(t=>t.status==="active").reduce((a, t) => a + t.minutesRemaining, 0);
      return res.json({ userId, totalMinutes, tokens });
    } catch (e) {
      console.error("GET /friday/balance", e);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  });

  // Primárny nákup z treasury (limit 20 ks / user / rok)
  router.post("/friday/purchase", async (req, res) => {
    try {
      const { userId, quantity, year } = req.body || {};
      if (!userId || !Number.isInteger(quantity) || quantity <= 0) {
        return res.status(400).json({ success: false, message: "Missing or invalid userId/quantity" });
      }
      const y = Number(year) || new Date().getFullYear();

      // koľko vlastní tento rok (aj mimo treasury)? Pre limit používame držané kusy z tohto roku
      const ownedThisYear = await prisma.fridayToken.count({
        where: { ownerId: userId, issuedYear: y },
      });
      if (ownedThisYear + quantity > MAX_PRIMARY_TOKENS_PER_USER) {
        return res.status(400).json({ success: false, message: `Primary limit is ${MAX_PRIMARY_TOKENS_PER_USER} tokens per user for year ${y}` });
      }

      // dostupné v treasury
      const available = await prisma.fridayToken.findMany({
        where: { ownerId: null, issuedYear: y, status: "active" },
        take: quantity,
        select: { id: true },
      });
      if (available.length < quantity) {
        return res.status(400).json({ success: false, message: "Not enough tokens in treasury" });
      }

      const unitPrice = priceForYear(y);
      const amountEur = unitPrice * quantity;

      await prisma.$transaction(async (tx) => {
        await tx.fridayToken.updateMany({
          where: { id: { in: available.map(a => a.id) } },
          data: { ownerId: userId },
        });
        await tx.transaction.create({
          data: {
            userId,
            type: "friday_purchase",
            amountEur: amountEur,
            secondsDelta: 0,
            note: `friday:${y}; qty:${quantity}`,
          },
        });
        await tx.fridaySupply.upsert({
          where: { year: y },
          update: { totalSold: { increment: quantity } },
          create: { year: y, totalMinted: 0, totalSold: quantity, priceEur: unitPrice },
        });
      });

      // vráť prehľad
      const tokens = await prisma.fridayToken.findMany({
        where: { ownerId: userId },
        select: { id: true, issuedYear: true, minutesRemaining: true, status: true },
        orderBy: [{ issuedYear: "asc" }, { createdAt: "asc" }],
      });
      const totalMinutes = tokens.filter(t=>t.status==="active").reduce((a, t) => a + t.minutesRemaining, 0);

      return res.json({ success: true, year: y, unitPrice, quantity, totalMinutes, tokens });
    } catch (e) {
      console.error("POST /friday/purchase", e);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  });

  // Zalistovať token na burzu
  router.post("/friday/list", async (req, res) => {
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

  // Zrušiť listing
  router.post("/friday/cancel-listing", async (req, res) => {
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

  // Zoznam otvorených listingov (burza)
  router.get("/friday/listings", async (req, res) => {
    try {
      const take = Math.min(Number(req.query.take) || 50, 100);
      const skip = Number(req.query.skip) || 0;
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

  // Kúpa z burzy
  router.post("/friday/buy-listing", async (req, res) => {
    try {
      const { buyerId, listingId } = req.body || {};
      if (!buyerId || !listingId) return res.status(400).json({ success: false, message: "Missing fields" });
      const listing = await prisma.fridayListing.findUnique({ where: { id: listingId } });
      if (!listing || listing.status !== "open") return res.status(400).json({ success: false, message: "Listing not available" });

      await prisma.$transaction(async (tx) => {
        await tx.fridayListing.update({ where: { id: listingId }, data: { status: "sold", closedAt: new Date() } });
        await tx.fridayToken.update({ where: { id: listing.tokenId }, data: { ownerId: buyerId, status: "active" } });
        await tx.transaction.createMany({
          data: [
            { userId: buyerId, type: "friday_trade_buy", amountEur: Number(listing.priceEur), secondsDelta: 0, note: `listing:${listingId}` },
            { userId: listing.sellerId, type: "friday_trade_sell", amountEur: Number(-listing.priceEur), secondsDelta: 0, note: `listing:${listingId}` },
          ],
        });
      });

      // vraciame nový piatkový zostatok kupujúceho
      const tokens = await prisma.fridayToken.findMany({
        where: { ownerId: buyerId },
        select: { id: true, issuedYear: true, minutesRemaining: true, status: true },
        orderBy: [{ issuedYear: "asc" }, { createdAt: "asc" }],
      });
      const totalMinutes = tokens.filter(t=>t.status==="active").reduce((a, t) => a + t.minutesRemaining, 0);

      return res.json({ success: true, totalMinutes, tokens });
    } catch (e) {
      console.error("POST /friday/buy-listing", e);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  });

  return router;
};
