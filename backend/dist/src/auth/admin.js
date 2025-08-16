"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ensureAdmin = ensureAdmin;
const express_1 = require("@clerk/express");
function ensureAdmin(req, res, next) {
    const { sessionClaims } = (0, express_1.getAuth)(req);
    // Clerk do JWT vkladá tvoje publicMetadata
    const role = sessionClaims?.publicMetadata?.role;
    if (role !== "admin") {
        return res.status(403).json({ success: false, message: "Admins only" });
    }
    next();
}
