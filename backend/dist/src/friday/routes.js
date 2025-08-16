"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = fridayRoutes;
// src/friday/routes.ts
const express_1 = __importDefault(require("express"));
const client_1 = require("@prisma/client");
const config_1 = require("./config");
function fridayRoutes(prisma) {
    const router = express_1.default.Router();
    async function ensureSettings() {
        const existing = await prisma.fridaySettings.findUnique({ where: { id: 1 } });
        if (!existing) {
            await prisma.fridaySettings.create({ data: { id: 1, currentPriceEur: 0 } });
        }
        return prisma.fridaySettings.findUnique({ where: { id: 1 } });
    }
    async function ensureUser(userId) {
        await prisma.user.upsert({
            where: { id: userId },
            update: {},
            create: { id: userId },
        });
    }
    // Mint tokenov (žiadna verifikácia, hocikto zavolá)
    router.post("/friday/admin/mint", async (req, res) => {
        try {
            const { quantity, priceEur } = req.body;
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
        }
        catch (e) {
            console.error("POST /friday/admin/mint", e);
            return res.status(500).json({ success: false, message: "Server error" });
        }
    });
    // Nastavenie ceny
    router.post("/friday/admin/set-price", async (req, res) => {
        try {
            const { newPrice, repriceTreasury } = req.body;
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
        }
        catch (e) {
            console.error("POST /friday/admin/set-price", e);
            return res.status(500).json({ success: false, message: "Server error" });
        }
    });
    // Kúpa z burzy (sekundárny obchod)
    router.post("/friday/buy-listing", async (req, res) => {
        const { buyerId, listingId } = (req.body || {});
        if (!buyerId || !listingId) {
            return res.status(400).json({ success: false, message: "Missing buyerId/listingId" });
        }
        try {
            await ensureUser(buyerId);
            const result = await prisma.$transaction(async (tx) => {
                // 1) načítaj listing + token
                const listing = await tx.fridayListing.findUnique({
                    where: { id: listingId },
                    include: { token: true },
                });
                if (!listing || listing.status !== "open")
                    throw new Error("Listing nie je dostupný");
                if (listing.sellerId === buyerId)
                    throw new Error("Nemôžeš kúpiť vlastný listing");
                // 2) limit 20/rok aj pre sekundárny nákup (ak nechceš, vyhoď tento blok)
                const ownedThisYear = await tx.fridayToken.count({
                    where: {
                        ownerId: buyerId,
                        issuedYear: listing.token.issuedYear,
                        status: { in: ["active", "listed"] },
                    },
                });
                if (ownedThisYear >= 20) {
                    throw new Error(`Limit 20 tokenov pre rok ${listing.token.issuedYear} dosiahnutý`);
                }
                // 3) „lockni“ listing (optimisticky)
                const locked = await tx.fridayListing.updateMany({
                    where: { id: listing.id, status: "open" },
                    data: { status: "sold", closedAt: new Date() },
                });
                if (locked.count !== 1)
                    throw new Error("Listing už bol uzavretý");
                // 4) over token (je stále u predajcu a v stave listed)
                const tok = await tx.fridayToken.findUnique({
                    where: { id: listing.tokenId },
                    select: { ownerId: true, status: true, minutesRemaining: true },
                });
                if (!tok || tok.ownerId !== listing.sellerId || tok.status !== "listed" || (tok.minutesRemaining ?? 0) <= 0) {
                    throw new Error("Token nie je možné kúpiť");
                }
                // 5) prehoď vlastníka tokenu späť na active
                await tx.fridayToken.update({
                    where: { id: listing.tokenId },
                    data: { ownerId: buyerId, status: "active" },
                });
                // 6) zapíš obchod
                const platformFeeEur = new client_1.Prisma.Decimal(0);
                const trade = await tx.fridayTrade.create({
                    data: {
                        listingId: listing.id,
                        tokenId: listing.tokenId,
                        sellerId: listing.sellerId,
                        buyerId,
                        priceEur: listing.priceEur,
                        platformFeeEur,
                    },
                });
                // 7) transakčné záznamy (buy/sell)
                await tx.transaction.createMany({
                    data: [
                        {
                            userId: buyerId,
                            type: "friday_trade_buy",
                            amountEur: listing.priceEur,
                            secondsDelta: 0,
                            note: `listing:${listing.id}; token:${listing.tokenId}`,
                        },
                        {
                            userId: listing.sellerId,
                            type: "friday_trade_sell",
                            amountEur: listing.priceEur, // prípadne odpočítaj fee
                            secondsDelta: 0,
                            note: `listing:${listing.id}; token:${listing.tokenId}`,
                        },
                    ],
                });
                return { tradeId: trade.id, tokenId: listing.tokenId, priceEur: listing.priceEur };
            });
            return res.json({ success: true, ...result });
        }
        catch (e) {
            console.error("POST /friday/buy-listing", e);
            return res.status(400).json({ success: false, message: e.message || "Buy failed" });
        }
    });
    // Supply
    router.get("/friday/supply", async (req, res) => {
        try {
            const y = Number(req.query.year || new Date().getFullYear());
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
        }
        catch (e) {
            console.error("GET /friday/supply", e);
            return res.status(500).json({ success: false, message: "Server error" });
        }
    });
    // Balance
    router.get("/friday/balance/:userId", async (req, res) => {
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
        }
        catch (e) {
            console.error("GET /friday/balance", e);
            return res.status(500).json({ success: false, message: "Server error" });
        }
    });
    // Purchase
    router.post("/friday/purchase", async (req, res) => {
        try {
            const { userId, quantity, year } = (req.body || {});
            if (!userId || !Number.isInteger(quantity) || quantity <= 0) {
                return res.status(400).json({ success: false, message: "Missing or invalid userId/quantity" });
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
            if (ownedThisYear + quantity > config_1.MAX_PRIMARY_TOKENS_PER_USER) {
                return res.status(400).json({
                    success: false,
                    message: `Primary limit is ${config_1.MAX_PRIMARY_TOKENS_PER_USER} tokens per user for year ${y}`,
                });
            }
            const available = await prisma.fridayToken.findMany({
                where: { ownerId: null, issuedYear: y, status: "active" },
                take: quantity,
                select: { id: true },
                orderBy: { createdAt: "asc" }, // deterministické
            });
            if (available.length < quantity) {
                return res.status(400).json({ success: false, message: "Not enough tokens in treasury" });
            }
            const amountEur = unitPrice * quantity;
            const purchasedTokenIds = available.map(a => a.id);
            await prisma.$transaction(async (tx) => {
                // 1) zapíš transakciu
                const tr = await tx.transaction.create({
                    data: {
                        userId,
                        type: "friday_purchase",
                        amountEur,
                        secondsDelta: 0,
                        note: `friday:${y}; qty:${quantity}; unit:${unitPrice}`,
                    },
                });
                // 2) priraď tokeny používateľovi
                await tx.fridayToken.updateMany({
                    where: { id: { in: purchasedTokenIds } },
                    data: { ownerId: userId },
                });
                // 3) položky nákupu – 1 riadok na každý token (kvôli auditovateľnosti)
                await tx.fridayPurchaseItem.createMany({
                    data: purchasedTokenIds.map((tokenId) => ({
                        transactionId: tr.id,
                        tokenId,
                        priceEur: unitPrice,
                    })),
                    skipDuplicates: true,
                });
                // 4) (voliteľné) zvýš predaj v FridaySupply
                await tx.fridaySupply.updateMany({
                    where: { year: y },
                    data: { totalSold: { increment: quantity } },
                });
            });
            // odpoveď – ako doteraz + pridáme purchasedTokenIds
            const tokens = await prisma.fridayToken.findMany({
                where: { ownerId: userId },
                select: { id: true, issuedYear: true, minutesRemaining: true, status: true },
                orderBy: [{ issuedYear: "asc" }, { createdAt: "asc" }],
            });
            const totalMinutes = tokens
                .filter((t) => t.status === "active")
                .reduce((a, t) => a + t.minutesRemaining, 0);
            return res.json({
                success: true,
                year: y,
                unitPrice,
                quantity,
                purchasedTokenIds, // <— TU máš presne ID zakúpených tokenov
                totalMinutes,
                tokens,
            });
        }
        catch (e) {
            console.error("POST /friday/purchase", e);
            return res.status(500).json({ success: false, message: "Server error" });
        }
    });
    // Listings
    router.post("/friday/list", async (req, res) => {
        try {
            const { sellerId, tokenId, priceEur } = (req.body || {});
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
        }
        catch (e) {
            console.error("POST /friday/list", e);
            return res.status(500).json({ success: false, message: "Server error" });
        }
    });
    router.post("/friday/cancel-listing", async (req, res) => {
        try {
            const { sellerId, listingId } = (req.body || {});
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
        }
        catch (e) {
            console.error("POST /friday/cancel-listing", e);
            return res.status(500).json({ success: false, message: "Server error" });
        }
    });
    router.get("/friday/listings", async (_req, res) => {
        try {
            const items = await prisma.fridayListing.findMany({
                where: { status: "open" },
                orderBy: { createdAt: "desc" },
                take: 50,
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
