// server.js
// Express + Prisma server pre Friday tokeny
// Funkcie:
// - GET  /health
// - GET  /friday/supply?year=YYYY
// - POST /friday/admin/mint         { adminId, year, quantity, priceEur }
// - POST /friday/admin/update-price { adminId, year, newPriceEur }

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { PrismaClient } = require("@prisma/client");

const app = express();
const prisma = new PrismaClient();

// --- CONFIG -----------------------------------------------------------------
const PORT = process.env.PORT || 3001;
const ADMIN_ID = process.env.ADMIN_ID || ""; // nastav vo .env
// voliteľné: defaultná cena, ak supply pre daný rok ešte neexistuje
const DEFAULT_PRICE_EUR =
  process.env.DEFAULT_PRICE_EUR && !Number.isNaN(Number(process.env.DEFAULT_PRICE_EUR))
    ? Number(process.env.DEFAULT_PRICE_EUR)
    : 400;

// --- MIDDLEWARE --------------------------------------------------------------
app.use(cors({ origin: "*", credentials: false }));
app.use(express.json());

// --- HELPERS -----------------------------------------------------------------
function assertAdmin(adminId) {
  if (!adminId || adminId !== ADMIN_ID) {
    const e = new Error("Not authorized");
    e.status = 403;
    throw e;
  }
}

/** Bezpečná konverzia na celé nezáporné číslo (> 0 ak required=true) */
function parsePositiveInt(value, field, required = true) {
  const n = Number(value);
  if (required && (value === undefined || value === null || value === "")) {
    const e = new Error(`${field} je povinné.`);
    e.status = 400;
    throw e;
  }
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < (required ? 1 : 0)) {
    const e = new Error(`${field} musí byť celé číslo ${required ? "> 0" : ">= 0"}.`);
    e.status = 400;
    throw e;
  }
  return n;
}

/** Bezpečná konverzia ceny v EUR (> 0) */
function parsePrice(value, field = "priceEur") {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    const e = new Error(`${field} musí byť číslo > 0.`);
    e.status = 400;
    throw e;
  }
  // zaokrúhlenie na 2 des. miesta (ak chceš striktne)
  return Math.round(n * 100) / 100;
}

/** JSON serializácia FridaySupply (Prisma Decimal -> Number) */
function serializeSupply(s) {
  if (!s) return null;
  return {
    year: s.year,
    priceEur: typeof s.priceEur?.toNumber === "function" ? s.priceEur.toNumber() : Number(s.priceEur),
    treasuryAvailable: s.treasuryAvailable,
    totalMinted: s.totalMinted,
    totalSold: s.totalSold,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

/** Zaistí existenciu supply pre daný rok. Vytvorí s default cenou, ak chýba. */
async function ensureSupply(year) {
  const y = parsePositiveInt(year, "year");
  let s = await prisma.fridaySupply.findUnique({ where: { year: y } });
  if (!s) {
    s = await prisma.fridaySupply.create({
      data: {
        year: y,
        priceEur: DEFAULT_PRICE_EUR,
        treasuryAvailable: 0,
        totalMinted: 0,
        totalSold: 0,
      },
    });
  }
  return s;
}

// --- ROUTES ------------------------------------------------------------------
app.get("/health", (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

/**
 * GET /friday/supply?year=YYYY
 * Vráti supply pre daný rok (ak neexistuje, vytvorí s default cenou a 0 ks).
 */
app.get("/friday/supply", async (req, res) => {
  try {
    const year = parsePositiveInt(req.query.year, "year");
    const s = await ensureSupply(year);
    res.json({ success: true, supply: serializeSupply(s) });
  } catch (e) {
    res.status(e.status || 500).json({ success: false, message: e.message || "Failed to get supply" });
  }
});

/**
 * POST /friday/admin/mint
 * Body: { adminId, year, quantity, priceEur }
 * - overí admina
 * - upsert na rok: navýši treasuryAvailable a totalMinted o quantity
 * - nastaví/aktualizuje priceEur na poskytnutú cenu
 */
app.post("/friday/admin/mint", async (req, res) => {
  try {
    const { adminId, year, quantity, priceEur } = req.body || {};
    assertAdmin(adminId);

    const y = parsePositiveInt(year, "year");
    const qty = parsePositiveInt(quantity, "quantity");
    const price = parsePrice(priceEur, "priceEur");

    // ak neexistuje, vytvoríme; ak existuje, zvyšujeme a aktualizujeme cenu
    const supply = await prisma.fridaySupply.upsert({
      where: { year: y },
      update: {
        treasuryAvailable: { increment: qty },
        totalMinted: { increment: qty },
        priceEur: price,
      },
      create: {
        year: y,
        priceEur: price,
        treasuryAvailable: qty,
        totalMinted: qty,
        totalSold: 0,
      },
    });

    res.json({
      success: true,
      message: `Vygenerovaných ${qty} tokenov pre ${y} s cenou ${price} €/ks.`,
      supply: serializeSupply(supply),
    });
  } catch (e) {
    res.status(e.status || 500).json({ success: false, message: e.message || "Mint failed" });
  }
});

/**
 * POST /friday/admin/update-price
 * Body: { adminId, year, newPriceEur }
 * - overí admina
 * - zmení priceEur pre daný rok (ovplyvní len ďalšie predaje z treasury)
 */
app.post("/friday/admin/update-price", async (req, res) => {
  try {
    const { adminId, year, newPriceEur } = req.body || {};
    assertAdmin(adminId);

    const y = parsePositiveInt(year, "year");
    const newPrice = parsePrice(newPriceEur, "newPriceEur");

    // musí existovať supply (ak nie, vytvoríme s 0 ks a nastavíme cenu)
    await ensureSupply(y);

    const updated = await prisma.fridaySupply.update({
      where: { year: y },
      data: { priceEur: newPrice },
    });

    res.json({
      success: true,
      message: `Cena pre ${y} nastavená na ${newPrice} €/token.`,
      supply: serializeSupply(updated),
    });
  } catch (e) {
    res.status(e.status || 500).json({ success: false, message: e.message || "Update price failed" });
  }
});

// --- GLOBAL ERROR HANDLER ----------------------------------------------------
app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  res.status(status).json({ success: false, message: err.message || "Server error" });
});

// --- START -------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`[friday] server listening at http://localhost:${PORT}`);
});
