"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ensureAdmin = ensureAdmin;
const server_1 = require("../server"); // ak máš helper inde, uprav cestu
async function ensureAdmin(req, res, next) {
    const userId = await (0, server_1.getUserIdFromAuthHeader)(req);
    if (!userId)
        return res.status(401).json({ success: false, message: "Unauthenticated" });
    if (userId !== process.env.ADMIN_ID)
        return res.status(403).json({ success: false, message: "Admins only" });
    req.authUserId = userId;
    next();
}
