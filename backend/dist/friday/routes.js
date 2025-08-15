"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = fridayRoutes;
// friday/routes.ts
const express_1 = __importDefault(require("express"));
const config_1 = require("./config");
function fridayRoutes(prisma) {
    const router = express_1.default.Router();
    async function ensureUser(userId) {
        await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });
    }
    router.post("/friday/mint-year", async (req, res) => {
        try {
            const { year } = req.body || {};
            const y = Number(year) || new Date().getFullYear();
            const exists = await prisma.fridaySupply.findUnique({ where: { year: y } });
            if (exists)
                return res.status(400).json({ success: false, message: "Supply already minted for this year" });
            const fridays = (0, config_1.countFridaysInYear)(y);
            const totalTokens = fridays * 6;
            const unitPrice = (0, config_1.priceForYear)(y);
            await prisma.$transaction(async (tx) => {
                await tx.fridaySupply.create({ data: { year: y, totalMinted: totalTokens, priceEur: unitPrice } });
                const batch = Array.from({ length: totalTokens }, () => ({
                    issuedYear: y, ownerId: null, minutesRemaining: 60, status: "active", originalPriceEur: unitPrice
                }));
                const CHUNK = 1000;
                for (let i = 0; i < batch.length; i += CHUNK) {
                    await tx.fridayToken.createMany({ data: batch.slice(i, i + CHUNK) });
                }
            });
            return res.json({ success: true, year: y, tokensMinted: totalTokens, unitPrice });
        }
        catch (e) {
            console.error("POST /friday/mint-year", e);
            return res.status(500).json({ success: false, message: "Server error" });
        }
    });
    router.get("/friday/supply", async (req, res) => {
        try {
            const y = Number(req.query.year || new Date().getFullYear());
            const sup = await prisma.fridaySupply.findUnique({ where: { year: y } });
            const priceEur = sup ? Number(sup.priceEur) : (0, config_1.priceForYear)(y);
            const treasuryCount = await prisma.fridayToken.count({
                where: { ownerId: null, issuedYear: y, status: "active" },
            });
            return res.json({
                year: y,
                priceEur,
                treasuryAvailable: treasuryCount,
                totalMinted: sup?.totalMinted ?? 0,
                totalSold: sup?.totalSold ?? 0,
            });
        }
        catch (e) {
            console.error("GET /friday/supply", e);
            return res.status(500).json({ success: false, message: "Server error" });
        }
    });
    router.get("/friday/balance/:userId", async (req, res) => {
        try {
            const { userId } = req.params;
            const tokens = await prisma.fridayToken.findMany({
                where: { ownerId: userId },
                orderBy: [{ issuedYear: "asc" }, { createdAt: "asc" }],
                select: { id: true, issuedYear: true, minutesRemaining: true, status: true },
            });
            const totalMinutes = tokens.filter(t => t.status === "active").reduce((a, t) => a + t.minutesRemaining, 0);
            return res.json({ userId, totalMinutes, tokens });
        }
        catch (e) {
            console.error("GET /friday/balance", e);
            return res.status(500).json({ success: false, message: "Server error" });
        }
    });
    router.post("/friday/purchase", async (req, res) => {
        try {
            const { userId, quantity, year } = req.body || {};
            if (!userId || !Number.isInteger(quantity) || quantity <= 0) {
                return res.status(400).json({ success: false, message: "Missing or invalid userId/quantity" });
            }
            const y = Number(year) || new Date().getFullYear();
            const ownedThisYear = await prisma.fridayToken.count({ where: { ownerId: userId, issuedYear: y } });
            if (ownedThisYear + quantity > config_1.MAX_PRIMARY_TOKENS_PER_USER) {
                return res.status(400).json({ success: false, message: `Primary limit is ${config_1.MAX_PRIMARY_TOKENS_PER_USER} tokens per user for year ${y}` });
            }
            const available = await prisma.fridayToken.findMany({
                where: { ownerId: null, issuedYear: y, status: "active" },
                take: quantity,
                select: { id: true },
            });
            if (available.length < quantity) {
                return res.status(400).json({ success: false, message: "Not enough tokens in treasury" });
            }
            const unitPrice = (0, config_1.priceForYear)(y);
            const amountEur = unitPrice * quantity;
            await prisma.$transaction(async (tx) => {
                await tx.fridayToken.updateMany({ where: { id: { in: available.map(a => a.id) } }, data: { ownerId: userId } });
                await tx.transaction.create({
                    data: { userId, type: "friday_purchase", amountEur: amountEur, secondsDelta: 0, note: `friday:${y}; qty:${quantity}` }
                });
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
            const totalMinutes = tokens.filter(t => t.status === "active").reduce((a, t) => a + t.minutesRemaining, 0);
            return res.json({ success: true, year: y, unitPrice, quantity, totalMinutes, tokens });
        }
        catch (e) {
            console.error("POST /friday/purchase", e);
            return res.status(500).json({ success: false, message: "Server error" });
        }
    });
    router.post("/friday/list", async (req, res) => {
        try {
            const { sellerId, tokenId, priceEur } = req.body || {};
            if (!sellerId || !tokenId || !priceEur)
                return res.status(400).json({ success: false, message: "Missing fields" });
            const token = await prisma.fridayToken.findUnique({ where: { id: tokenId } });
            if (!token || token.ownerId !== sellerId)
                return res.status(400).json({ success: false, message: "Token not owned by seller" });
            if (token.status !== "active" || token.minutesRemaining <= 0)
                return res.status(400).json({ success: false, message: "Token not listable" });
            await prisma.$transaction(async (tx) => {
                await tx.fridayToken.update({ where: { id: tokenId }, data: { status: "listed" } });
                await tx.fridayListing.create({ data: { tokenId, sellerId, priceEur: Number(priceEur) } });
            });
            return res.json({ success: true });
        }
        catch (e) {
            console.error("POST /friday/list", e);
            return res.status(500).json({ success: false, message: "Server error" });
        }
    });
    router.post("/friday/buy-listing", async (req, res) => {
        try {
            const { buyerId, listingId } = req.body || {};
            if (!buyerId || !listingId) {
                return res.status(400).json({ success: false, message: "Missing buyerId/listingId" });
            }
            const listing = await prisma.fridayListing.findUnique({
                where: { id: listingId },
                include: { token: true },
            });
            if (!listing || listing.status !== "open") {
                return res.status(400).json({ success: false, message: "Listing not available" });
            }
            if (!listing.token || listing.token.status !== "listed") {
                return res.status(400).json({ success: false, message: "Token not listed" });
            }
            if (listing.sellerId === buyerId) {
                return res.status(400).json({ success: false, message: "Seller cannot buy own token" });
            }
            await prisma.$transaction(async (tx) => {
                await tx.fridayListing.update({
                    where: { id: listingId },
                    data: { status: "sold", closedAt: new Date() },
                });
                // If you want to record the buyer, make sure your schema has a buyerId field and update it in a separate call:
                // await tx.fridayListing.update({ where: { id: listingId }, data: { buyerId } });
                await tx.fridayToken.update({
                    where: { id: listing.tokenId },
                    data: { ownerId: buyerId, status: "active" },
                });
                await tx.transaction.create({
                    data: {
                        userId: buyerId,
                        type: "friday_secondary_buy", // TODO: Replace 'as any' with the correct TransactionType enum, e.g. $Enums.TransactionType.FridaySecondaryBuy
                        amountEur: Number(listing.priceEur),
                        secondsDelta: 0,
                        note: `listing:${listingId}`,
                    },
                });
            });
            // vráť nový stav buyer balancu (nepovinné, ale handy pre UI)
            const tokens = await prisma.fridayToken.findMany({
                where: { ownerId: buyerId },
                orderBy: [{ issuedYear: "asc" }, { createdAt: "asc" }],
                select: { id: true, issuedYear: true, minutesRemaining: true, status: true },
            });
            const totalMinutes = tokens.filter(t => t.status === "active")
                .reduce((a, t) => a + t.minutesRemaining, 0);
            return res.json({ success: true, totalMinutes, tokens });
        }
        catch (e) {
            console.error("POST /friday/buy-listing", e);
            return res.status(500).json({ success: false, message: "Server error" });
        }
    });
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
        }
        catch (e) {
            console.error("POST /friday/cancel-listing", e);
            return res.status(500).json({ success: false, message: "Server error" });
        }
    });
    router.get("/friday/listings", async (_req, res) => {
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
        }
        catch (e) {
            console.error("GET /friday/listings", e);
            return res.status(500).json({ success: false, message: "Server error" });
        }
    });
    return router;
}
